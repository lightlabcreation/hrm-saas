const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const mysqldump = require('mysqldump');
const nodemailer = require('nodemailer');
const { decrypt } = require('../utils/cryptoUtils');
const { sendSystemEmail } = require('../utils/emailService');

const backupsDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
}

/**
 * Get Basic Backup Info & Admin Details
 */
exports.getBackupStats = async (req, res) => {
    try {
        const [userRows] = await db.execute('SELECT id, name, email, role FROM users WHERE id = ?', [req.user.id]);
        const adminUser = userRows[0] || {};

        let lastBackupDate = null;
        if (fs.existsSync(backupsDir)) {
            const files = fs.readdirSync(backupsDir);
            if (files.length > 0) {
                const latestFile = files
                    .map(f => ({ name: f, time: fs.statSync(path.join(backupsDir, f)).mtime }))
                    .sort((a, b) => new Date(b.time) - new Date(a.time))[0];
                lastBackupDate = latestFile ? latestFile.time : null;
            }
        }

        res.json({
            success: true,
            admin: {
                name: adminUser.name || 'Admin',
                email: adminUser.email || req.user.email || '',
                role: adminUser.role || 'admin'
            },
            lastBackup: lastBackupDate
        });
    } catch (err) {
        console.error('Error in getBackupStats:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch backup info', error: err.message });
    }
};

/**
 * Helper to export database to .sql (Supports full or custom date range)
 */
async function exportDatabaseSql({ startDate, endDate, tempFilePath }) {
    if (!startDate && !endDate) {
        try {
            await mysqldump({
                connection: {
                    host: process.env.DB_HOST || 'localhost',
                    user: process.env.DB_USER || 'root',
                    password: process.env.DB_PASSWORD || '',
                    database: process.env.DB_NAME || 'hrm-saas-kiaan',
                    port: parseInt(process.env.DB_PORT) || 3306
                },
                dumpToFile: tempFilePath,
            });
            return;
        } catch (e) {
            console.warn('mysqldump failed, using JS SQL dump generator...', e.message);
        }
    }

    const tables = [
        'companies', 'users', 'employees', 'settings', 'global_settings', 
        'geofences', 'kpis', 'public_holidays', 'company_email_settings', 
        'company_backup_schedules', 'attendance', 'payroll', 'leaves', 'claims'
    ];

    let sqlOutput = `-- Nexus HRM Pro Database Backup\n`;
    if (startDate && endDate) {
        sqlOutput += `-- Filter: Custom Date Range (${startDate} to ${endDate})\n`;
    } else {
        sqlOutput += `-- Scope: Full Historical Database Snapshot\n`;
    }
    sqlOutput += `-- Generated on: ${new Date().toISOString()}\n\n`;

    for (const table of tables) {
        try {
            let query = `SELECT * FROM \`${table}\``;
            let params = [];

            if (startDate && endDate) {
                if (table === 'attendance') {
                    query = `SELECT * FROM \`attendance\` WHERE (date BETWEEN ? AND ?) OR (created_at BETWEEN ? AND ?)`;
                    params = [startDate, endDate, `${startDate} 00:00:00`, `${endDate} 23:59:59`];
                } else if (table === 'payroll') {
                    query = `SELECT * FROM \`payroll\` WHERE (cycle_start <= ? AND cycle_end >= ?) OR (created_at BETWEEN ? AND ?)`;
                    params = [endDate, startDate, `${startDate} 00:00:00`, `${endDate} 23:59:59`];
                } else if (table === 'leaves') {
                    query = `SELECT * FROM \`leaves\` WHERE (start_date <= ? AND end_date >= ?) OR (created_at BETWEEN ? AND ?)`;
                    params = [endDate, startDate, `${startDate} 00:00:00`, `${endDate} 23:59:59`];
                } else if (table === 'claims') {
                    query = `SELECT * FROM \`claims\` WHERE (expense_date BETWEEN ? AND ?) OR (created_at BETWEEN ? AND ?)`;
                    params = [startDate, endDate, `${startDate} 00:00:00`, `${endDate} 23:59:59`];
                }
            }

            const [rows] = await db.execute(query, params);
            if (rows.length > 0) {
                sqlOutput += `-- Table: ${table} (${rows.length} rows)\n`;
                const keys = Object.keys(rows[0]);
                const colsList = keys.map(k => `\`${k}\``).join(', ');
                for (const row of rows) {
                    const vals = keys.map(k => {
                        const val = row[k];
                        if (val === null || val === undefined) return 'NULL';
                        if (typeof val === 'number') return val;
                        if (typeof val === 'boolean') return val ? 1 : 0;
                        if (val instanceof Date) return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
                        return `'${String(val).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
                    }).join(', ');
                    sqlOutput += `INSERT INTO \`${table}\` (${colsList}) VALUES (${vals});\n`;
                }
                sqlOutput += '\n';
            }
        } catch (tErr) {}
    }

    fs.writeFileSync(tempFilePath, sqlOutput, 'utf8');
}

/**
 * Generate Full Database Backup (.sql) (Supports Custom Date Range)
 * Option to download directly or send to entered email
 */
exports.generateBackup = async (req, res) => {
    const { email, sendToEmail, startDate, endDate } = req.body || {};
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const hasDateRange = startDate && endDate;
    const filename = hasDateRange 
        ? `nexus_hrm_backup_${startDate}_to_${endDate}_${timestamp}.sql` 
        : `nexus_hrm_backup_${timestamp}.sql`;
    const tempFilePath = path.join(backupsDir, filename);

    try {
        console.log(`📦 Generating Database Backup (${hasDateRange ? `${startDate} to ${endDate}` : 'Full'}): ${filename}...`);
        await exportDatabaseSql({ startDate, endDate, tempFilePath });

        // If email delivery is requested
        const targetEmail = email || req.user.email;
        if (sendToEmail && targetEmail) {
            try {
                const fileContent = fs.readFileSync(tempFilePath);
                const companyId = req.user.company_id || req.user.id;
                const [smtpRows] = await db.execute(
                    'SELECT * FROM company_email_settings WHERE company_id = ? AND is_active = 1 LIMIT 1',
                    [companyId]
                );

                const backupHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
                        <div style="background: linear-gradient(135deg, #4f46e5, #7c3aed); padding: 24px; border-radius: 12px; text-align: center; color: white;">
                            <h2 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.5px;">📦 HR PILOT PRO SYSTEM Backup</h2>
                            <p style="margin: 6px 0 0 0; opacity: 0.9; font-size: 13px;">${hasDateRange ? `Date Range: ${startDate} to ${endDate}` : 'Full Database Snapshot'}</p>
                        </div>
                        <div style="padding: 24px 8px 8px 8px; color: #334155; font-size: 14px; line-height: 1.6;">
                            <p>Hello <strong>${req.user.name || 'Admin'}</strong>,</p>
                            <p>Your requested database backup file has been generated and is attached to this email.</p>
                            <table style="width: 100%; border-collapse: collapse; margin: 18px 0; background: #f8fafc; border-radius: 10px; font-size: 13px;">
                                <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #64748b;">File:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-family: monospace; color: #4f46e5; font-weight: bold;">${filename}</td></tr>
                                <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #64748b;">Scope:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">${hasDateRange ? `${startDate} to ${endDate}` : 'All Time (Full Database)'}</td></tr>
                                <tr><td style="padding: 12px; font-weight: bold; color: #64748b;">Generated At:</td><td style="padding: 12px; font-weight: bold; color: #0f172a;">${new Date().toLocaleString()}</td></tr>
                            </table>
                            <p style="color: #64748b; font-size: 12px;">🛡️ Please keep this backup secure for disaster recovery purposes.</p>
                        </div>
                    </div>
                `;

                if (smtpRows.length > 0) {
                    const s = smtpRows[0];
                    const password = decrypt(s.smtp_pass);
                    const transporter = nodemailer.createTransport({
                        host: s.smtp_host,
                        port: parseInt(s.smtp_port),
                        secure: parseInt(s.smtp_port) === 465,
                        auth: {
                            user: s.smtp_user,
                            pass: password,
                        }
                    });

                    await transporter.sendMail({
                        from: `"${s.sender_name || 'HR Department'}" <${s.sender_email || s.smtp_user}>`,
                        to: targetEmail,
                        subject: `📦 HR PILOT PRO SYSTEM - Database Backup (${new Date().toLocaleDateString()})`,
                        html: backupHtml,
                        attachments: [
                            {
                                filename,
                                content: fileContent
                            }
                        ]
                    });
                    console.log(`📧 [Company SMTP] Backup copy sent to: ${targetEmail}`);
                } else {
                    await sendSystemEmail({
                        to: targetEmail,
                        toName: req.user.name || 'Admin',
                        subject: `📦 HR PILOT PRO SYSTEM - Database Backup (${new Date().toLocaleDateString()})`,
                        htmlContent: backupHtml,
                        attachments: [
                            {
                                filename,
                                content: fileContent
                            }
                        ]
                    });
                    console.log(`📧 [System SMTP] Backup copy sent to: ${targetEmail}`);
                }
            } catch (mailErr) {
                console.warn('Could not send backup email (download will still work):', mailErr.message);
            }
        }

        res.download(tempFilePath, filename, (err) => {
            if (err) console.error('Download stream error:', err);
        });
    } catch (err) {
        console.error('❌ Backup generation failed:', err);
        res.status(500).json({ success: false, message: 'Database backup failed', error: err.message });
    }
};

/**
 * Restore Database from uploaded Backup file (.sql or .json)
 */
exports.restoreBackup = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No backup file uploaded. Please upload a .sql or .json file.' });
        }

        const filePath = req.file.path;
        const ext = path.extname(req.file.originalname).toLowerCase();
        console.log(`🔄 Processing Database Restore from: ${req.file.originalname} (${ext})`);

        if (ext === '.sql') {
            const sqlContent = fs.readFileSync(filePath, 'utf8');
            // Split SQL queries safely
            const queries = sqlContent
                .replace(/--.*$/gm, '') // Remove single-line comments
                .replace(/\/\*[\s\S]*?\*\//gm, '') // Remove multi-line comments
                .split(/;\s*[\r\n]+/)
                .map(q => q.trim())
                .filter(q => q.length > 0 && !q.startsWith('/*') && !q.startsWith('--'));

            console.log(`Executing ${queries.length} queries for SQL restore...`);

            // Execute in transaction
            await db.execute('SET FOREIGN_KEY_CHECKS = 0');
            for (const q of queries) {
                try {
                    await db.execute(q);
                } catch (qErr) {
                    console.warn('Skipped non-fatal statement during restore:', qErr.message.slice(0, 100));
                }
            }
            await db.execute('SET FOREIGN_KEY_CHECKS = 1');

            // Cleanup uploaded file
            try { fs.unlinkSync(filePath); } catch (e) {}

            return res.json({
                success: true,
                message: `Database restored successfully from ${req.file.originalname} (${queries.length} statements executed).`
            });
        } else if (ext === '.json') {
            const jsonContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const data = jsonContent.data || jsonContent;

            await db.execute('SET FOREIGN_KEY_CHECKS = 0');
            for (const table of Object.keys(data)) {
                const rows = data[table];
                if (Array.isArray(rows) && rows.length > 0) {
                    for (const row of rows) {
                        const keys = Object.keys(row);
                        const cols = keys.map(k => `\`${k}\``).join(', ');
                        const placeholders = keys.map(() => '?').join(', ');
                        const values = keys.map(k => row[k]);
                        const updateClause = keys.map(k => `\`${k}\`=VALUES(\`${k}\`)`).join(', ');

                        const sql = `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClause}`;
                        try {
                            await db.execute(sql, values);
                        } catch (rErr) {}
                    }
                }
            }
            await db.execute('SET FOREIGN_KEY_CHECKS = 1');

            try { fs.unlinkSync(filePath); } catch (e) {}

            return res.json({
                success: true,
                message: `JSON dataset restored successfully from ${req.file.originalname}.`
            });
        } else {
            try { fs.unlinkSync(filePath); } catch (e) {}
            return res.status(400).json({ success: false, message: 'Invalid file format. Please upload a .sql or .json file.' });
        }
    } catch (err) {
        console.error('❌ Restore failed:', err);
        res.status(500).json({ success: false, message: 'Database restore failed', error: err.message });
    }
};

/**
 * Send Database Backup directly to a target email (Supports Custom Date Range)
 */
exports.sendBackupToEmail = async (req, res) => {
    const { email, startDate, endDate } = req.body || {};
    const targetEmail = email || req.user.email;
    if (!targetEmail) {
        return res.status(400).json({ success: false, message: 'Recipient email address is required.' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const hasDateRange = startDate && endDate;
    const filename = hasDateRange 
        ? `nexus_hrm_backup_${startDate}_to_${endDate}_${timestamp}.sql` 
        : `nexus_hrm_backup_${timestamp}.sql`;
    const tempFilePath = path.join(backupsDir, filename);

    try {
        console.log(`📦 Generating Database Backup for Email Delivery to ${targetEmail}: ${filename}...`);
        await exportDatabaseSql({ startDate, endDate, tempFilePath });

        const fileContent = fs.readFileSync(tempFilePath);
        const companyId = req.user.company_id || req.user.id;
        const [smtpRows] = await db.execute(
            'SELECT * FROM company_email_settings WHERE company_id = ? AND is_active = 1 LIMIT 1',
            [companyId]
        );

        let emailSent = false;
        let errorMessage = '';

        const backupHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
                <div style="background: linear-gradient(135deg, #4f46e5, #7c3aed); padding: 24px; border-radius: 12px; text-align: center; color: white;">
                    <h2 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.5px;">📦 HR PILOT PRO SYSTEM Backup</h2>
                    <p style="margin: 6px 0 0 0; opacity: 0.9; font-size: 13px;">${hasDateRange ? `Date Range: ${startDate} to ${endDate}` : 'Full Database Snapshot'}</p>
                </div>
                <div style="padding: 24px 8px 8px 8px; color: #334155; font-size: 14px; line-height: 1.6;">
                    <p>Hello <strong>${req.user.name || 'Admin'}</strong>,</p>
                    <p>Your requested database backup file has been generated and is attached to this email.</p>
                    <table style="width: 100%; border-collapse: collapse; margin: 18px 0; background: #f8fafc; border-radius: 10px; font-size: 13px;">
                        <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #64748b;">File:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-family: monospace; color: #4f46e5; font-weight: bold;">${filename}</td></tr>
                        <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #64748b;">Scope:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">${hasDateRange ? `${startDate} to ${endDate}` : 'All Time (Full Database)'}</td></tr>
                        <tr><td style="padding: 12px; font-weight: bold; color: #64748b;">Generated At:</td><td style="padding: 12px; font-weight: bold; color: #0f172a;">${new Date().toLocaleString()}</td></tr>
                    </table>
                    <p style="color: #64748b; font-size: 12px;">🛡️ Please keep this backup secure for disaster recovery purposes.</p>
                </div>
            </div>
        `;

        if (smtpRows.length > 0) {
            const s = smtpRows[0];
            try {
                const password = decrypt(s.smtp_pass);
                const transporter = nodemailer.createTransport({
                    host: s.smtp_host,
                    port: parseInt(s.smtp_port),
                    secure: parseInt(s.smtp_port) === 465,
                    auth: {
                        user: s.smtp_user,
                        pass: password,
                    }
                });

                await transporter.sendMail({
                    from: `"${s.sender_name || 'HR Department'}" <${s.sender_email || s.smtp_user}>`,
                    to: targetEmail,
                    subject: `📦 HR PILOT PRO SYSTEM - Database Backup (${new Date().toLocaleDateString()})`,
                    html: backupHtml,
                    attachments: [
                        {
                            filename,
                            content: fileContent
                        }
                    ]
                });
                console.log(`📧 [Company SMTP] Backup email delivered to ${targetEmail} via ${s.smtp_user}`);
                emailSent = true;
            } catch (smtpErr) {
                console.error(`❌ [Company SMTP] Failed to send backup to ${targetEmail}:`, smtpErr.message);
                errorMessage = `SMTP Error (${s.smtp_host}): ${smtpErr.message}`;
            }
        } else {
            // Fallback to system-level sender if no company SMTP is configured
            try {
                const sysRes = await sendSystemEmail({
                    to: targetEmail,
                    toName: req.user.name || 'Administrator',
                    subject: `📦 HR PILOT PRO SYSTEM - Database Backup (${new Date().toLocaleDateString()})`,
                    htmlContent: backupHtml,
                    attachments: [
                        {
                            filename,
                            content: fileContent
                        }
                    ]
                });
                emailSent = !!sysRes;
            } catch (sysErr) {
                errorMessage = sysErr.message;
            }
        }

        if (emailSent) {
            return res.json({ success: true, message: `Database backup file (${filename}) has been sent to ${targetEmail} successfully!` });
        } else {
            return res.status(400).json({ 
                success: false, 
                message: errorMessage ? `Backup email delivery failed: ${errorMessage}` : 'Backup file generated, but email delivery failed. Please verify SMTP credentials in Settings > Email SMTP.' 
            });
        }
    } catch (err) {
        console.error('❌ Send backup to email error:', err);
        return res.status(500).json({ success: false, message: 'Failed to send backup via email: ' + err.message });
    }
};

// Ensure company_backup_schedules table exists
(async () => {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS company_backup_schedules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                company_id INT NOT NULL UNIQUE,
                is_enabled TINYINT(1) DEFAULT 1,
                frequency_days INT DEFAULT 7,
                target_email VARCHAR(255) DEFAULT '',
                last_run_at DATETIME DEFAULT NULL,
                next_run_at DATETIME DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
    } catch (e) {
        console.warn('Could not init company_backup_schedules table:', e.message);
    }
})();

/**
 * Get Automated Backup Schedule
 */
exports.getBackupSchedule = async (req, res) => {
    try {
        const companyId = req.user.company_id || req.user.id;
        const [rows] = await db.execute('SELECT * FROM company_backup_schedules WHERE company_id = ?', [companyId]);
        
        if (rows.length === 0) {
            return res.json({
                success: true,
                schedule: {
                    is_enabled: 1,
                    frequency_days: 7,
                    target_email: req.user.email || '',
                    last_run_at: null,
                    next_run_at: null
                }
            });
        }

        res.json({
            success: true,
            schedule: rows[0]
        });
    } catch (err) {
        console.error('Error in getBackupSchedule:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch backup schedule', error: err.message });
    }
};

/**
 * Save / Update Automated Backup Schedule
 */
exports.saveBackupSchedule = async (req, res) => {
    try {
        const companyId = req.user.company_id || req.user.id;
        const { is_enabled, frequency_days, target_email } = req.body;

        const freq = parseInt(frequency_days) || 7;
        const enabled = is_enabled ? 1 : 0;
        const email = target_email || req.user.email || '';

        const [existing] = await db.execute('SELECT * FROM company_backup_schedules WHERE company_id = ?', [companyId]);

        if (existing.length > 0) {
            await db.execute(
                `UPDATE company_backup_schedules 
                 SET is_enabled = ?, frequency_days = ?, target_email = ?, next_run_at = DATE_ADD(IFNULL(last_run_at, NOW()), INTERVAL ? DAY), updated_at = NOW() 
                 WHERE company_id = ?`,
                [enabled, freq, email, freq, companyId]
            );
        } else {
            await db.execute(
                `INSERT INTO company_backup_schedules 
                 (company_id, is_enabled, frequency_days, target_email, next_run_at) 
                 VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
                [companyId, enabled, freq, email, freq]
            );
        }

        res.json({ 
            success: true, 
            message: `Automatic backup schedule saved! System will automatically create & email complete backups every ${freq} days.` 
        });
    } catch (err) {
        console.error('Error in saveBackupSchedule:', err);
        res.status(500).json({ success: false, message: 'Failed to save backup schedule', error: err.message });
    }
};

/**
 * Background Automatic Backup Runner (Checks every hour)
 */
async function runScheduledAutoBackups() {
    try {
        const [schedules] = await db.execute(`
            SELECT s.*, 
                   (SELECT u.name FROM users u WHERE (u.company_id = s.company_id OR u.id = s.company_id) AND u.role IN ('admin', 'MasterAdmin') LIMIT 1) AS admin_name 
            FROM company_backup_schedules s
            WHERE s.is_enabled = 1 
              AND (s.last_run_at IS NULL OR TIMESTAMPDIFF(DAY, s.last_run_at, NOW()) >= s.frequency_days)
        `);

        if (!schedules || schedules.length === 0) return;

        for (const sched of schedules) {
            try {
                const targetEmail = sched.target_email;
                if (!targetEmail || !targetEmail.includes('@')) continue;

                console.log(`⏰ [Auto-Backup Scheduler] Creating ${sched.frequency_days}-day automated backup for company ${sched.company_id} to ${targetEmail}...`);

                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const filename = `nexus_hrm_auto_backup_${sched.frequency_days}d_${timestamp}.sql`;
                const tempFilePath = path.join(backupsDir, filename);

                // Dump database
                try {
                    await mysqldump({
                        connection: {
                            host: process.env.DB_HOST || 'localhost',
                            user: process.env.DB_USER || 'root',
                            password: process.env.DB_PASSWORD || '',
                            database: process.env.DB_NAME || 'hrm-saas-kiaan',
                            port: parseInt(process.env.DB_PORT) || 3306
                        },
                        dumpToFile: tempFilePath,
                    });
                } catch (e) {
                    const tables = ['companies', 'users', 'employees', 'attendance', 'payroll', 'leaves', 'claims', 'settings', 'global_settings', 'geofences', 'kpis', 'public_holidays', 'company_email_settings', 'company_backup_schedules'];
                    let sqlOutput = `-- Nexus HRM Pro Automated Scheduled Backup (${sched.frequency_days} Days Cycle)\n-- Generated on: ${new Date().toISOString()}\n\n`;

                    for (const table of tables) {
                        try {
                            const [rows] = await db.execute(`SELECT * FROM \`${table}\``);
                            if (rows.length > 0) {
                                sqlOutput += `-- Table: ${table}\n`;
                                const keys = Object.keys(rows[0]);
                                const colsList = keys.map(k => `\`${k}\``).join(', ');
                                for (const row of rows) {
                                    const vals = keys.map(k => {
                                        const val = row[k];
                                        if (val === null || val === undefined) return 'NULL';
                                        if (typeof val === 'number') return val;
                                        if (typeof val === 'boolean') return val ? 1 : 0;
                                        if (val instanceof Date) return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
                                        return `'${String(val).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
                                    }).join(', ');
                                    sqlOutput += `INSERT INTO \`${table}\` (${colsList}) VALUES (${vals});\n`;
                                }
                                sqlOutput += '\n';
                            }
                        } catch (tErr) {}
                    }
                    fs.writeFileSync(tempFilePath, sqlOutput, 'utf8');
                }

                const fileContent = fs.readFileSync(tempFilePath);
                const [smtpRows] = await db.execute(
                    'SELECT * FROM company_email_settings WHERE company_id = ? AND is_active = 1 LIMIT 1',
                    [sched.company_id]
                );

                const backupHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
                        <div style="background: linear-gradient(135deg, #4f46e5, #7c3aed); padding: 24px; border-radius: 12px; text-align: center; color: white;">
                            <h2 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.5px;">⏰ Automated System Backup</h2>
                            <p style="margin: 6px 0 0 0; opacity: 0.9; font-size: 13px;">Recurring (${sched.frequency_days} Days) Database Snapshot</p>
                        </div>
                        <div style="padding: 24px 8px 8px 8px; color: #334155; font-size: 14px; line-height: 1.6;">
                            <p>Hello <strong>${sched.admin_name || 'Admin'}</strong>,</p>
                            <p>This is your automated recurring system database backup. The complete backup file is attached to this email.</p>
                            <table style="width: 100%; border-collapse: collapse; margin: 18px 0; background: #f8fafc; border-radius: 10px; font-size: 13px;">
                                <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #64748b;">File:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-family: monospace; color: #4f46e5; font-weight: bold;">${filename}</td></tr>
                                <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #64748b;">Schedule:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #0f172a;">Every ${sched.frequency_days} Days</td></tr>
                                <tr><td style="padding: 12px; font-weight: bold; color: #64748b;">Generated At:</td><td style="padding: 12px; font-weight: bold; color: #0f172a;">${new Date().toLocaleString()}</td></tr>
                            </table>
                            <p style="color: #64748b; font-size: 12px;">🛡️ Please keep this backup secure for disaster recovery purposes.</p>
                        </div>
                    </div>
                `;

                if (smtpRows.length > 0) {
                    const s = smtpRows[0];
                    const password = decrypt(s.smtp_pass);
                    const transporter = nodemailer.createTransport({
                        host: s.smtp_host,
                        port: parseInt(s.smtp_port),
                        secure: parseInt(s.smtp_port) === 465,
                        auth: { user: s.smtp_user, pass: password }
                    });

                    await transporter.sendMail({
                        from: `"${s.sender_name || 'HR Department'}" <${s.sender_email || s.smtp_user}>`,
                        to: targetEmail,
                        subject: `⏰ Automated System Backup (Every ${sched.frequency_days} Days) - HR PILOT PRO SYSTEM`,
                        html: backupHtml,
                        attachments: [{ filename, content: fileContent }]
                    });
                } else {
                    await sendSystemEmail({
                        to: targetEmail,
                        toName: sched.admin_name || 'Admin',
                        subject: `⏰ Automated System Backup (Every ${sched.frequency_days} Days) - HR PILOT PRO SYSTEM`,
                        htmlContent: backupHtml,
                        attachments: [{ filename, content: fileContent }]
                    });
                }

                // Update last run and next run
                await db.execute(
                    'UPDATE company_backup_schedules SET last_run_at = NOW(), next_run_at = DATE_ADD(NOW(), INTERVAL frequency_days DAY) WHERE id = ?',
                    [sched.id]
                );
                console.log(`✅ [Auto-Backup Scheduler] Successfully dispatched ${sched.frequency_days}-day backup to ${targetEmail}`);
            } catch (autoErr) {
                console.error(`❌ [Auto-Backup Scheduler] Failed for company ${sched.company_id}:`, autoErr.message);
            }
        }
    } catch (e) {
        console.warn('Auto backup loop error:', e.message);
    }
}

// Check every 30 minutes in background
setInterval(runScheduledAutoBackups, 30 * 60 * 1000);
setTimeout(runScheduledAutoBackups, 8000); // Also check 8s after start



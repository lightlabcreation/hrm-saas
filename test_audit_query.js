require('dotenv').config();
const db = require('./config/db');

async function test() {
    try {
        const companyId = 16;
        const page = 1;
        const limit = 20;
        const offset = (page - 1) * limit;

        let whereClauses = ['(a.company_id = ? OR (a.company_id IS NULL AND u.company_id = ?))'];
        let queryParams = [companyId, companyId];

        const whereSql = whereClauses.join(' AND ');

        // Count Total
        const countQuery = `
            SELECT COUNT(*) AS total 
            FROM audit_logs a
            LEFT JOIN users u ON a.admin_id = u.id
            WHERE ${whereSql}
        `;
        const [countResult] = await db.execute(countQuery, queryParams);
        console.log("Count result:", countResult);

        // Fetch Paginated Logs with LIMIT ? OFFSET ?
        const dataQuery = `
            SELECT 
                a.id,
                a.admin_id,
                a.action,
                a.target_id,
                a.details,
                a.created_at,
                u.name AS admin_name,
                u.email AS admin_email,
                u.role AS admin_role,
                u.photo AS admin_photo
            FROM audit_logs a
            LEFT JOIN users u ON a.admin_id = u.id
            WHERE ${whereSql}
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?
        `;
        console.log("Testing execute with LIMIT ? OFFSET ?...");
        const [rows] = await db.execute(dataQuery, [...queryParams, limit, offset]);
        console.log("Rows count:", rows.length);
    } catch (err) {
        console.error("CAUGHT ERROR:", err);
    }
    process.exit(0);
}
test();

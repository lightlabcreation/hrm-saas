require('dotenv').config();
const db = require('./config/db');

async function updateDb() {
    try {
        console.log("Checking and updating platform_name & business_name in DB...");
        
        // 1. global_settings
        try {
            await db.execute('UPDATE global_settings SET platform_name = "HR Pilot Pro", company_name = "HR Pilot Pro" WHERE platform_name LIKE "%Nexus%" OR company_name LIKE "%Nexus%"');
            console.log("Updated global_settings");
        } catch (e) {
            console.log("global_settings update note:", e.message);
        }

        // 2. settings
        try {
            await db.execute('UPDATE settings SET business_name = "HR Pilot Pro" WHERE business_name LIKE "%Nexus%"');
            console.log("Updated settings");
        } catch (e) {
            console.log("settings update note:", e.message);
        }

        console.log("Done updating names.");
    } catch (err) {
        console.error("Error:", err);
    }
    process.exit(0);
}

updateDb();

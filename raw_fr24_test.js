const axios = require('axios');

async function checkRawFeed() {
    try {
        console.log("=== RAW FR24 FEED TEST (Ground Traffic at HKT) ===");
        
        // HKT bounds roughly:
        // North: 8.125, South: 8.095, West: 98.300, East: 98.325
        const bounds = "8.125,8.095,98.300,98.325";
        
        const url = `https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=${bounds}&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=1&estimated=1&gliders=1`;
        
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const data = res.data;
        let count = 0;
        
        for (const [key, val] of Object.entries(data)) {
            if (key === 'full_count' || key === 'version') continue;
            count++;
            // val is an array of flight data
            // [0:id, 1:lat, 2:lon, 3:track, 4:alt, 5:speed, 6:squawk, 7:radar, 8:model, 9:reg, 10:timestamp, 11:origin, 12:dest, 13:flight, 14:onGround, 15:vspeed, 16:callsign, 17:isGlider]
            console.log(`\nFound object ID: ${key}`);
            console.log(`  Callsign: ${val[16]}`);
            console.log(`  Model: ${val[8]} | Reg: ${val[9]}`);
            console.log(`  Speed: ${val[5]} kts | Altitude: ${val[4]} ft`);
            console.log(`  On Ground: ${val[14] ? 'YES' : 'NO'}`);
            console.log(`  Origin: ${val[11]} | Dest: ${val[12]}`);
        }
        
        if (count === 0) {
            console.log("\nNo objects found in the HKT ground bounds.");
        }
        
    } catch (err) {
        console.error("Error:", err.message);
    }
}

checkRawFeed();

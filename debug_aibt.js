const { fetchFromRadar } = require('flightradar24-client');
const { getStandInfo } = require('./hkt_stands');

async function debugGround() {
    try {
        console.log(`\n=== HKT GROUND DEBUG (${new Date().toLocaleTimeString()}) ===`);
        const north = 8.150, west = 98.250, south = 8.080, east = 98.350;
        
        const flights = await fetchFromRadar(north, west, south, east, null, {
            onGround: true,
            inactive: true
        });
        
        let found = 0;
        for (const f of flights) {
             const origin = (f.origin || "").toUpperCase();
             const destination = (f.destination || "").toUpperCase();
             if (origin === 'HKT' || destination === 'HKT' || (f.isOnGround && destination !== 'HKT' && destination !== "")) {
                 found++;
                 const info = getStandInfo(f.latitude, f.longitude);
                 console.log(`Flight: ${f.callsign || f.flight} | Dest: ${destination} | Orig: ${origin}`);
                 console.log(`  Pos: ${f.latitude.toFixed(5)}, ${f.longitude.toFixed(5)}`);
                 console.log(`  Speed: ${f.speed} kts | Alt: ${f.altitude} ft | OnGround: ${f.isOnGround}`);
                 console.log(`  Nearest Stand: ${info.stand} (${info.apron}) -> Distance: ${info.distance.toFixed(1)} m`);
             }
        }
        if (found === 0) console.log("No HKT related ground flights found in this poll.");
    } catch (e) {
        console.error("Error:", e.message);
    }
}

// Run immediately, then a few more times
debugGround();
setTimeout(debugGround, 10000);
setTimeout(debugGround, 20000);

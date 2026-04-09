const { fetchFromRadar } = require('flightradar24-client');
const { getStandInfo } = require('./hkt_stands');

async function debugAllGround() {
    try {
        console.log("=== HKT ALL GROUND TRAFFIC ===");
        const north = 8.150, west = 98.250, south = 8.080, east = 98.350;
        
        const flights = await fetchFromRadar(north, west, south, east, null, {
            onGround: true,
            inactive: true
        });
        
        console.log(`Found ${flights.length} objects on ground at HKT bounds.`);
        
        for (const f of flights) {
            const info = getStandInfo(f.latitude, f.longitude);
            console.log(`\nID: ${f.id} | CS: ${f.callsign} | FL: ${f.flight}`);
            console.log(`  Pos: ${f.latitude}, ${f.longitude}`);
            console.log(`  Origin: ${f.origin} | Dest: ${f.destination}`);
            console.log(`  Nearest Stand: ${info.stand} (${info.distance.toFixed(1)}m)`);
        }
        
    } catch (err) {
        console.error("Error:", err.message);
    }
}

debugAllGround();

const { fetchFromRadar } = require('flightradar24-client');
const { getStandInfo } = require('./hkt_stands');

async function debugFlights() {
    try {
        console.log("=== HKT RADAR DEBUG (Distance Check) ===");
        const north = 8.150, west = 98.250, south = 8.080, east = 98.350;
        
        const flights = await fetchFromRadar(north, west, south, east, null, {
            onGround: true,
            inactive: true
        });
        
        const targets = ['SIA740', 'SQ740', 'VZ2304', 'TVJ2304'];
        
        console.log(`Found ${flights.length} objects on ground.`);
        
        for (const f of flights) {
            const callsign = (f.callsign || "").toUpperCase();
            const flightCode = (f.flight || "").toUpperCase();
            
            if (targets.includes(callsign) || targets.includes(flightCode)) {
                const info = getStandInfo(f.latitude, f.longitude);
                console.log(`\nTARGET FOUND: ${callsign} (${flightCode})`);
                console.log(`  Current Pos: ${f.latitude}, ${f.longitude}`);
                console.log(`  Speed: ${f.speed} kts | OnGround: ${f.isOnGround}`);
                console.log(`  Nearest Stand: ${info.stand} (${info.apron})`);
                console.log(`  Current Distance: ${info.distance.toFixed(2)} meters`);
                
                if (info.distance > 15) {
                    console.log(`  ⚠️  CAUTION: Distance is greater than 15m! (Current threshold)`);
                } else {
                    console.log(`  ✅ Within 15m radius.`);
                }
            }
        }
        
    } catch (err) {
        console.error("Error:", err.message);
    }
}

debugFlights();

const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

async function testOptions() {
    try {
        console.log("=== FR24 CLIENT TEST (w/ onGround: true) ===");
        const north = 8.150, south = 8.080, west = 98.250, east = 98.350;
        
        // Pass the options parameter!
        const flights = await fetchFromRadar(north, west, south, east, null, {
            onGround: true,
            inactive: true
        });
        
        console.log(`Found ${flights.length} flights on ground at HKT bounds:`);
        for (const f of flights) {
            console.log(`  Callsign: ${f.callsign} | Flight: ${f.flight} | OnGround: ${f.isOnGround} | Speed: ${f.speed} kts`);
        }
        
    } catch (err) {
        console.error("Error:", err.message);
    }
}

testOptions();

const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

async function debugATA() {
    try {
        console.log("=== ATA DEBUG: Searching for HKT flights ===\n");
        
        // Scan the close zone
        const flights = await fetchFromRadar(20.0, 90.0, 0.0, 110.0);
        
        // Find ALL flights related to HKT
        const hktArrivals = flights.filter(f => 
            f.destination && f.destination.toUpperCase() === 'HKT'
        );
        
        console.log(`Total HKT arrivals found: ${hktArrivals.length}\n`);
        
        // Check each one for isOnGround status
        for (const f of hktArrivals) {
            const callsign = f.callsign || f.flight || f.id;
            console.log(`Flight: ${callsign}`);
            console.log(`  isOnGround: ${f.isOnGround}`);
            console.log(`  altitude: ${f.altitude}`);
            console.log(`  speed: ${f.speed}`);
            console.log(`  destination: ${f.destination}`);
            
            if (f.isOnGround) {
                console.log(`  >>> THIS FLIGHT IS ON GROUND AT HKT - SHOULD TRIGGER ATA <<<`);
                // Fetch detail to see arrival time
                try {
                    const detail = await fetchFlight(f.id);
                    console.log(`  arrival: ${detail.arrival}`);
                    console.log(`  scheduledArrival: ${detail.scheduledArrival}`);
                } catch (e) {
                    console.log(`  Error fetching detail: ${e.message}`);
                }
            }
            console.log('---');
        }
        
        // Also check: are there any flights on ground NEAR HKT coordinates?
        // HKT airport coordinates: 8.1132, 98.3169
        console.log("\n=== Flights on ground near HKT airport (within ~0.5 deg) ===");
        const nearHKT = flights.filter(f => 
            f.isOnGround && 
            f.latitude > 7.6 && f.latitude < 8.6 &&
            f.longitude > 97.8 && f.longitude < 98.8
        );
        console.log(`Found ${nearHKT.length} flights on ground near HKT:`);
        for (const f of nearHKT) {
            console.log(`  ${f.callsign || f.flight || f.id} | dest: ${f.destination} | origin: ${f.origin} | alt: ${f.altitude} | spd: ${f.speed}`);
        }
        
    } catch (err) {
        console.error("Error:", err.message);
    }
}

debugATA();

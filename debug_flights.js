const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

async function debugFlights() {
    try {
        console.log("Scanning for HKT-bound flights...");
        // Use the first zone from index.js for quick scan
        const flights = await fetchFromRadar(20.0, 90.0, 0.0, 110.0);
        
        const hktFlights = flights.filter(f => 
            f.destination && f.destination.toUpperCase() === 'HKT'
        );

        if (hktFlights.length === 0) {
            console.log("No HKT-bound flights found in the current scan zone.");
            return;
        }

        console.log(`Found ${hktFlights.length} HKT-bound flights. Fetching details for the first 2...\n`);

        for (let i = 0; i < Math.min(2, hktFlights.length); i++) {
            const flight = hktFlights[i];
            console.log(`--- FLIGHT ${i+1} SUMMARY (from fetchFromRadar) ---`);
            console.log(JSON.stringify(flight, null, 2));
            
            console.log(`\n--- FLIGHT ${i+1} DETAILS (from fetchFlight) ---`);
            try {
                const detail = await fetchFlight(flight.id);
                console.log(JSON.stringify(detail, null, 2));
            } catch (err) {
                console.log(`Error fetching details for ${flight.id}: ${err.message}`);
            }
            console.log("\n" + "=".repeat(50) + "\n");
        }
    } catch (err) {
        console.error("Error:", err.message);
    }
}

debugFlights();

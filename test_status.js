const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

async function checkLandedStatus() {
    try {
        console.log("Scanning for HKT-bound flights...");
        const flights = await fetchFromRadar(20.0, 90.0, 0.0, 110.0);
        
        const hktFlights = flights.filter(f => 
            f.destination && f.destination.toUpperCase() === 'HKT'
        );

        console.log(`Found ${hktFlights.length} HKT-bound flights.`);

        for (const flight of hktFlights) {
            const detail = await fetchFlight(flight.id);
            console.log(`Flight: ${flight.callsign || flight.id}`);
            // Check for status or arrival indicators
            console.log(`  - departure: ${detail.departure}`);
            console.log(`  - arrival: ${detail.arrival}`);
            console.log(`  - scheduledArrival: ${detail.scheduledArrival}`);
            // Check for potential status fields
            console.log(`  - status components: ${Object.keys(detail).filter(k => k.toLowerCase().includes('status'))}`);
            console.log(`  - all keys: ${Object.keys(detail).join(', ')}`);
            
            // If arrival is in the past, it might be landed
            const arrivalTime = new Date(detail.arrival);
            const now = new Date();
            if (arrivalTime < now) {
                console.log(`  >>> POTENTIALLY LANDED (Arrival: ${detail.arrival}, Now: ${now.toISOString()})`);
            }
            console.log('---');
        }
    } catch (err) {
        console.error("Error:", err.message);
    }
}

checkLandedStatus();

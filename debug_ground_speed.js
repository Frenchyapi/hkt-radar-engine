const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

async function quickTest() {
    try {
        console.log(`=== QUICK TEST (2-min wait) === Time: ${new Date().toISOString()}\n`);
        
        const flights1 = await fetchFromRadar(20.0, 90.0, 0.0, 110.0);
        const hkt1 = flights1.filter(f => (f.destination || "").toUpperCase() === "HKT");
        console.log(`Scan 1 (${hkt1.length} arrivals):`);
        for (const f of hkt1) console.log(`  ${f.callsign || f.id} (${f.id}) | alt:${f.altitude} spd:${f.speed}`);
        
        console.log(`\nWaiting 2 min...`);
        await new Promise(r => setTimeout(r, 120000));
        
        const flights2 = await fetchFromRadar(20.0, 90.0, 0.0, 110.0);
        const hkt2 = flights2.filter(f => (f.destination || "").toUpperCase() === "HKT");
        const ids2 = new Set(hkt2.map(f => f.id));
        console.log(`\nScan 2 (${hkt2.length} arrivals) at ${new Date().toISOString()}:`);
        
        const gone = hkt1.filter(f => !ids2.has(f.id));
        
        if (gone.length === 0) {
            console.log("No disappearances.");
            // Also try: manually call fetchFlight on TLM758 ID from earlier
            console.log("\n--- Manual test: trying TLM758 (3efe2054) ---");
            try {
                const d = await fetchFlight("3efe2054");
                console.log(`  ✅ Works! arrival: ${d.arrival} | departure: ${d.departure} | liveData: ${d.liveData}`);
            } catch(e) { console.log(`  ❌ ${e.message}`); }
            
            console.log("\n--- Manual test: trying BKP407 (3efe3d21) ---");
            try {
                const d = await fetchFlight("3efe3d21");
                console.log(`  ✅ Works! arrival: ${d.arrival} | departure: ${d.departure} | liveData: ${d.liveData}`);
            } catch(e) { console.log(`  ❌ ${e.message}`); }
        } else {
            console.log(`\n🎯 ${gone.length} DISAPPEARED!`);
            for (const f of gone) {
                console.log(`\n>>> ${f.callsign} (${f.id})`);
                try {
                    const d = await fetchFlight(f.id);
                    console.log(`  ✅ fetchFlight WORKS!`);
                    console.log(`  arrival:   ${d.arrival}`);
                    console.log(`  departure: ${d.departure}`);
                    console.log(`  liveData:  ${d.liveData}`);
                } catch (e) { console.log(`  ❌ ${e.message}`); }
            }
        }
    } catch (err) { console.error(err.message); }
}
quickTest();

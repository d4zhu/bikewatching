// Import Mapbox as an ESM module
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Set your Mapbox access token here
mapboxgl.accessToken = 'pk.eyJ1IjoiZDR6aHUiLCJhIjoiY21hcTVrZmw4MDVtMDJtcG1nYXU4dWR0aSJ9.YbpF9i8JLxU6wR1K2ofxAQ';

// ───────────────────────────────────────────────────────────────
// 1. Initialize Mapbox
// ───────────────────────────────────────────────────────────────
const map = new mapboxgl.Map({
  container: 'map',
  style:     'mapbox://styles/mapbox/streets-v11',
  center:    [-71.0589, 42.3601],
  zoom:      12
});


// ───────────────────────────────────────────────────────────────
// 2. Global Helpers
// ───────────────────────────────────────────────────────────────

// Project lon/lat → screen coords
function getCoords(station) {
  const pt = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(pt);
  return { cx: x, cy: y };
}

// Roll up arrivals/departures & compute totalTraffic
function computeStationTraffic(stations, trips) {
  const departures = d3.rollup(trips, v => v.length, d => d.start_station_id);
  const arrivals   = d3.rollup(trips, v => v.length, d => d.end_station_id);

  return stations.map(station => {
    const id = station.short_name;
    station.arrivals     = arrivals.get(id)    ?? 0;
    station.departures   = departures.get(id)  ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// Convert Date → minutes since midnight
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Filter trips ±60 min around timeFilter
function filterTripsByTime(trips, timeFilter) {
  if (timeFilter === -1) return trips;
  return trips.filter(trip => {
    const m0 = minutesSinceMidnight(trip.started_at);
    const m1 = minutesSinceMidnight(trip.ended_at);
    return Math.abs(m0 - timeFilter) <= 60 || Math.abs(m1 - timeFilter) <= 60;
  });
}

// Format minutes → “h:mm AM/PM”
function formatTime(minutes) {
  const d = new Date(0,0,0,0,minutes);
  return d.toLocaleString('en-US', { timeStyle: 'short' });
}


// ───────────────────────────────────────────────────────────────
// 3. map.on('load'): draw lanes, load data, initial plot
// ───────────────────────────────────────────────────────────────
map.on('load', async () => {
  // 3.1 Boston bike lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'assets/Existing_Bike_Network_2022.geojson'
  });
  map.addLayer({
    id:    'boston-lanes',
    type:  'line',
    source:'boston_route',
    paint: {'line-color':'green','line-width':4,'line-opacity':0.4}
  });

  // 3.2 Cambridge bike lanes
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'assets/cambridge_bike_network.geojson'
  });
  map.addLayer({
    id:    'cambridge-lanes',
    type:  'line',
    source:'cambridge_route',
    paint: {'line-color':'blue','line-width':4,'line-opacity':0.4}
  });

  // 3.3 Fetch station info
  let stations;
  try {
    const json = await d3.json('assets/bluebikes-stations.json');
    stations = json.data.stations;
  } catch (e) {
    return console.error('Station load error', e);
  }

  // 3.4 Fetch + parse trips CSV
  let trips;
  try {
    trips = await d3.csv(
      'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
      d => ({ ...d,
        started_at: new Date(d.started_at),
        ended_at:   new Date(d.ended_at)
      })
    );
  } catch (e) {
    return console.error('Trips load error', e);
  }

  // 3.5 Prepare SVG overlay
  const svg = d3.select('#map').select('svg');

  // 3.6 Initial compute & draw
  stations = computeStationTraffic(stations, trips);

  // radius scale
  const radiusScale = d3.scaleSqrt()
    .domain([0, d3.max(stations, d => d.totalTraffic)])
    .range([0, 25]);

  // flow quantize scale (0→arrivals, 0.5→balanced, 1→departures)
  const stationFlow = d3.scaleQuantize([0,1],[0,0.5,1]);

  // Bind circles with key, initial attrs & CSS var
  let circles = svg.selectAll('circle')
    .data(stations, d => d.short_name)
    .enter().append('circle')
      .attr('fill',               'var(--color)')
      .attr('stroke',             '#fff')
      .attr('stroke-width',       0.5)
      .attr('fill-opacity',       0.6)
      .attr('pointer-events',     'auto')
      .attr('r',                  d => radiusScale(d.totalTraffic))
      .style('--departure-ratio', d => stationFlow(d.departures / d.totalTraffic))
      .each(function(d) {
        d3.select(this).append('title')
          .text(`${d.totalTraffic} trips (${d.departures} dep, ${d.arrivals} arr)`);
      });

  // Positioning function
  function updatePositions() {
    circles
      .attr('cx', d => getCoords(d).cx)
      .attr('cy', d => getCoords(d).cy);
  }
  updatePositions();
  ['move','zoom','resize','rotate','moveend'].forEach(e => map.on(e, updatePositions));

  // ─────────────────────────────────────────────────────────────
  // 4/5: Time‐slider hookup & dynamic filtering
  // ─────────────────────────────────────────────────────────────
  let timeFilter = -1;
  const timeSlider   = document.getElementById('timeSlider');
  const selectedTime = document.getElementById('selectedTime');
  const anyTimeLabel = document.querySelector('.any-time');

  function updateScatterPlot(tf) {
    // filter trips & recompute station stats
    const ftrips    = filterTripsByTime(trips, tf);
    const fstations = computeStationTraffic(JSON.parse(JSON.stringify(stations)), ftrips);

    // adjust radius range
    radiusScale.range(tf === -1 ? [0,25] : [3,50]);

    // re-bind & update radii + flow
    circles = svg.selectAll('circle')
      .data(fstations, d => d.short_name)
      .join(
        enter => enter,
        update => update,
        exit => exit.remove()
      )
      .attr('r',                  d => radiusScale(d.totalTraffic))
      .style('--departure-ratio', d => stationFlow(d.departures / d.totalTraffic));

    updatePositions();
  }

  function updateTimeDisplay() {
    timeFilter = +timeSlider.value;
    if (timeFilter === -1) {
      selectedTime.textContent   = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent   = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }
    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
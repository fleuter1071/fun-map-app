const statusEl = document.getElementById('statusText');
const progressTrackEl = document.getElementById('progressTrack');
const progressFillEl = document.getElementById('progressFill');

const LOADING_COLOR = "rgba(148,163,184,0.35)";
const ERROR_COLOR = "rgba(100,116,139,0.85)";

// Clustering configuration. Adjust radiusPx to tune collision avoidance aggressiveness.
const CLUSTER_CONFIG = {
  radiusPx: 16,
  minPoints: 2
};

function setProgress(done, total, failed = 0){
  if(!progressTrackEl || !progressFillEl) return;
  const pct = total ? Math.max(0, Math.min(1, done / total)) : 0;
  progressTrackEl.style.display = "inline-flex";
  progressFillEl.style.width = `${(pct * 100).toFixed(1)}%`;
  if(done >= total){
    progressTrackEl.style.opacity = "0.65";
  } else {
    progressTrackEl.style.opacity = "1";
  }
}

function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }

function loadScript(url){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve(url);
    s.onerror = () => reject(new Error('Failed to load ' + url));
    document.head.appendChild(s);
  });
}

async function loadWithFallback(urls, name){
  let lastErr;
  for(const u of urls){
    try { await loadScript(u); return u; }
    catch(e){ lastErr = e; }
  }
  throw new Error(`Could not load ${name}. Last error: ${lastErr && lastErr.message}`);
}

async function start(){
  try {
    setStatus('Loading libraries...');
    await loadWithFallback([
      'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js',
      'https://unpkg.com/d3@7/dist/d3.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'
    ], 'd3');
    await loadWithFallback([
      'https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js',
      'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/topojson-client/3.1.0/topojson-client.min.js'
    ], 'topojson-client');

    if(!window.d3 || !window.topojson){
      throw new Error('Libraries loaded but not available on window (d3/topojson).');
    }
    startApp();
  } catch (e) {
    console.error(e);
    setStatus('Failed to load required libraries. Check internet/CDN access.');
  }
}
function startApp(){
  const CLUSTER_DOT_RADIUS = 12;
  let clusterState = {
    zoomK: 1,
    clusters: [],
    cityToCluster: new Map()
  };

  function getWeatherIconType(code) {
    const c = Number(code);
    if (!Number.isFinite(c)) return "cloud";
    if (c === 0 || c === 1) return "sun";
    if (c === 2 || c === 3) return "cloud";
    if (c === 45 || c === 48) return "fog";
    if ([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(c)) return "rain";
    if ([71,73,75,77,85,86].includes(c)) return "snow";
    if ([95,96,99].includes(c)) return "storm";
    return "cloud";
  }

  function appendWeatherIconGlyph(parent, extraClass = "") {
    const icon = parent.append("g")
      .attr("class", `weather-icon ${extraClass}`.trim())
      .attr("transform", "translate(6,-8)")
      .style("pointer-events", "none");

    icon.append("path")
      .attr("class", "weather-icon-cloud")
      .attr("d", "M-5,2 C-6,-2 -2,-5 2,-4 C4,-7 10,-6 11,-1 C14,-1 15,4 11,5 H-4 C-7,5 -8,3 -5,2 Z");

    icon.append("circle")
      .attr("class", "weather-icon-sun-core")
      .attr("cx", 3.5)
      .attr("cy", -1.2)
      .attr("r", 2.8);

    const rays = icon.append("g").attr("class", "weather-icon-sun-rays");
    const rayAngles = [0, 45, 90, 135, 180, 225, 270, 315];
    rayAngles.forEach((deg) => {
      const rad = (deg * Math.PI) / 180;
      const x1 = 3.5 + Math.cos(rad) * 4.1;
      const y1 = -1.2 + Math.sin(rad) * 4.1;
      const x2 = 3.5 + Math.cos(rad) * 5.7;
      const y2 = -1.2 + Math.sin(rad) * 5.7;
      rays.append("line")
        .attr("x1", x1)
        .attr("y1", y1)
        .attr("x2", x2)
        .attr("y2", y2);
    });

    const rain = icon.append("g").attr("class", "weather-icon-rain");
    rain.append("line").attr("x1", -1).attr("y1", 6).attr("x2", -2.3).attr("y2", 8.6);
    rain.append("line").attr("x1", 2).attr("y1", 6.2).attr("x2", 0.7).attr("y2", 8.8);
    rain.append("line").attr("x1", 5).attr("y1", 6).attr("x2", 3.7).attr("y2", 8.6);

    const snow = icon.append("g").attr("class", "weather-icon-snow");
    [-1.8, 3.2].forEach((x) => {
      snow.append("line").attr("x1", x - 0.8).attr("y1", 7.2).attr("x2", x + 0.8).attr("y2", 7.2);
      snow.append("line").attr("x1", x).attr("y1", 6.4).attr("x2", x).attr("y2", 8.0);
    });

    icon.append("path")
      .attr("class", "weather-icon-bolt")
      .attr("d", "M4,4 L1,8 H3 L1,11 L6,6 H4 Z");

    const fog = icon.append("g").attr("class", "weather-icon-fog");
    fog.append("line").attr("x1", -3.5).attr("y1", 7).attr("x2", 9.5).attr("y2", 7);
    fog.append("line").attr("x1", -2.5).attr("y1", 9).attr("x2", 8.5).attr("y2", 9);

    return icon;
  }

  function updateWeatherIconsForSelection(selection, cityAccessor = (d) => d) {
    selection.each(function (d) {
      const city = cityAccessor(d);
      const icon = d3.select(this).select("g.weather-icon");
      if (icon.empty()) return;
      const wx = city?._wx;
      const code = wx?.hourly?.code?.[selectedHourIndex];
      const type = (wx && !city?._wxError) ? getWeatherIconType(code) : null;
      icon.style("display", type ? null : "none");
      icon.select(".weather-icon-sun-core").style("display", type === "sun" ? null : "none");
      icon.select(".weather-icon-sun-rays").style("display", type === "sun" ? null : "none");
      icon.select(".weather-icon-cloud").style("display", ["cloud", "rain", "snow", "storm", "fog"].includes(type) ? null : "none");
      icon.select(".weather-icon-rain").style("display", type === "rain" ? null : "none");
      icon.select(".weather-icon-snow").style("display", type === "snow" ? null : "none");
      icon.select(".weather-icon-bolt").style("display", type === "storm" ? null : "none");
      icon.select(".weather-icon-fog").style("display", type === "fog" ? null : "none");
    });
  }

  async function fetchJsonWithTimeout(url, timeoutMs=12000){
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {signal: controller.signal, headers: {'Accept':'application/json'}});
      if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  async function loadUSAtlasStates(){
    const urls = ['https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json', 'https://unpkg.com/us-atlas@3/states-10m.json', 'https://cdnjs.cloudflare.com/ajax/libs/us-atlas/3.0.1/states-10m.json'];
    let lastErr;
    for(const u of urls){ try { return await fetchJsonWithTimeout(u); } catch(e){ lastErr = e; } }
    throw new Error('Failed to load map JSON from all sources.');
  }

  const CITIES = [{"city":"New York","state":"NY","lat":40.6943,"lon":-73.9249,"pop":8537673},{"city":"Los Angeles","state":"CA","lat":34.114,"lon":-118.4068,"pop":3976322},{"city":"Chicago","state":"IL","lat":41.8373,"lon":-87.6861,"pop":2704958},{"city":"Houston","state":"TX","lat":29.7871,"lon":-95.3936,"pop":2303482},{"city":"Phoenix","state":"AZ","lat":33.5722,"lon":-112.0891,"pop":1615017},{"city":"Philadelphia","state":"PA","lat":40.0076,"lon":-75.134,"pop":1567872},{"city":"San Antonio","state":"TX","lat":29.4722,"lon":-98.5247,"pop":1492510},{"city":"San Diego","state":"CA","lat":32.8312,"lon":-117.1225,"pop":1406630},{"city":"Dallas","state":"TX","lat":32.7938,"lon":-96.7659,"pop":1317929},{"city":"San Jose","state":"CA","lat":37.302,"lon":-121.8488,"pop":1025350},{"city":"Austin","state":"TX","lat":30.3038,"lon":-97.7545,"pop":947890},{"city":"Jacksonville","state":"FL","lat":30.3322,"lon":-81.6749,"pop":880619},{"city":"San Francisco","state":"CA","lat":37.7561,"lon":-122.4429,"pop":870887},{"city":"Columbus","state":"OH","lat":39.9859,"lon":-82.9852,"pop":860090},{"city":"Indianapolis","state":"IN","lat":39.7771,"lon":-86.1458,"pop":855164},{"city":"Fort Worth","state":"TX","lat":32.7813,"lon":-97.3466,"pop":854113},{"city":"Charlotte","state":"NC","lat":35.208,"lon":-80.8308,"pop":842051},{"city":"Seattle","state":"WA","lat":47.6217,"lon":-122.3238,"pop":704352},{"city":"Denver","state":"CO","lat":39.7621,"lon":-104.8759,"pop":693060},{"city":"El Paso","state":"TX","lat":31.8478,"lon":-106.431,"pop":683080},{"city":"Washington","state":"DC","lat":38.9047,"lon":-77.0163,"pop":681170},{"city":"Boston","state":"MA","lat":42.3189,"lon":-71.0838,"pop":673184},{"city":"Detroit","state":"MI","lat":42.3834,"lon":-83.1024,"pop":672795},{"city":"Nashville","state":"TN","lat":36.1714,"lon":-86.7844,"pop":660388},{"city":"Memphis","state":"TN","lat":35.1047,"lon":-89.9773,"pop":652717},{"city":"Portland","state":"OR","lat":45.5372,"lon":-122.65,"pop":639863},{"city":"Oklahoma City","state":"OK","lat":35.4677,"lon":-97.5138,"pop":638367},{"city":"Las Vegas","state":"NV","lat":36.2288,"lon":-115.2603,"pop":632912},{"city":"Louisville","state":"KY","lat":38.1662,"lon":-85.6488,"pop":616261},{"city":"Baltimore","state":"MD","lat":39.3051,"lon":-76.6144,"pop":614664},{"city":"Milwaukee","state":"WI","lat":43.064,"lon":-87.9669,"pop":595047},{"city":"Albuquerque","state":"NM","lat":35.1055,"lon":-106.6476,"pop":559277},{"city":"Tucson","state":"AZ","lat":32.1558,"lon":-110.8777,"pop":530706},{"city":"Fresno","state":"CA","lat":36.7834,"lon":-119.7933,"pop":522053},{"city":"Sacramento","state":"CA","lat":38.5666,"lon":-121.4683,"pop":495234},{"city":"Mesa","state":"AZ","lat":33.4016,"lon":-111.718,"pop":484587},{"city":"Kansas City","state":"MO","lat":39.1239,"lon":-94.5541,"pop":481420},{"city":"Atlanta","state":"GA","lat":33.7627,"lon":-84.4231,"pop":472522},{"city":"Long Beach","state":"CA","lat":33.8059,"lon":-118.161,"pop":470130},{"city":"Colorado Springs","state":"CO","lat":38.8673,"lon":-104.7605,"pop":465101},{"city":"Raleigh","state":"NC","lat":35.8323,"lon":-78.6441,"pop":458880},{"city":"Miami","state":"FL","lat":25.784,"lon":-80.2102,"pop":453579},{"city":"Virginia Beach","state":"VA","lat":36.7335,"lon":-76.0435,"pop":452602},{"city":"Omaha","state":"NE","lat":41.2634,"lon":-96.0453,"pop":446970},{"city":"Oakland","state":"CA","lat":37.7903,"lon":-122.2165,"pop":420005},{"city":"Minneapolis","state":"MN","lat":44.9635,"lon":-93.2679,"pop":413651},{"city":"Tulsa","state":"OK","lat":36.1284,"lon":-95.9037,"pop":403090},{"city":"Arlington","state":"TX","lat":32.6998,"lon":-97.1251,"pop":392772},{"city":"New Orleans","state":"LA","lat":30.0687,"lon":-89.9288,"pop":391495},{"city":"Wichita","state":"KS","lat":37.6894,"lon":-97.344,"pop":389902}];

  const HORROR_CITIES = (Array.isArray(window.HORROR_CITIES_CONFIG) ? window.HORROR_CITIES_CONFIG : [])
    .map((city) => {
      const parsedYear = Number(city?.movieYear);
      return {
        city: String(city?.city || "").trim(),
        state: String(city?.state || "").trim().toUpperCase(),
        lat: Number(city?.lat),
        lon: Number(city?.lon),
        pop: Number(city?.pop) || 0,
        movie: String(city?.movie || "").trim(),
        movieYear: Number.isFinite(parsedYear) ? parsedYear : null
      };
    })
    .filter((city) => city.city && city.state && Number.isFinite(city.lat) && Number.isFinite(city.lon));

  let TOP_CITIES = CITIES.map((c) => ({ ...c }));
  let activeCities = TOP_CITIES;
  const SPORTS_DICTIONARY = {
    "New York,NY": ["New York Knicks", "Brooklyn Nets", "New York Yankees", "New York Mets", "New York Rangers", "New York Islanders", "New York Giants", "New York Jets"],
    "Los Angeles,CA": ["Los Angeles Lakers", "Los Angeles Clippers", "Los Angeles Dodgers", "Los Angeles Angels", "Los Angeles Kings", "Anaheim Ducks", "Los Angeles Rams", "Los Angeles Chargers"],
    "Chicago,IL": ["Chicago Bulls", "Chicago Bears", "Chicago Cubs", "Chicago White Sox", "Chicago Blackhawks"],
    "Houston,TX": ["Houston Rockets", "Houston Astros", "Houston Texans"],
    "Phoenix,AZ": ["Phoenix Suns", "Arizona Diamondbacks", "Arizona Cardinals"],
    "Philadelphia,PA": ["Philadelphia 76ers", "Philadelphia Phillies", "Philadelphia Eagles", "Philadelphia Flyers"],
    "San Antonio,TX": ["San Antonio Spurs"],
    "San Diego,CA": ["San Diego Padres"],
    "Dallas,TX": ["Dallas Mavericks", "Dallas Stars", "Dallas Cowboys", "Texas Rangers"],
    "San Jose,CA": ["San Jose Sharks"],
    "Austin,TX": [],
    "Jacksonville,FL": ["Jacksonville Jaguars"],
    "San Francisco,CA": ["San Francisco 49ers", "San Francisco Giants", "Golden State Warriors"],
    "Columbus,OH": ["Columbus Blue Jackets"],
    "Indianapolis,IN": ["Indianapolis Colts", "Indiana Pacers"],
    "Fort Worth,TX": [],
    "Charlotte,NC": ["Charlotte Hornets", "Carolina Panthers"],
    "Seattle,WA": ["Seattle Seahawks", "Seattle Mariners", "Seattle Kraken"],
    "Denver,CO": ["Denver Nuggets", "Denver Broncos", "Colorado Rockies", "Colorado Avalanche"],
    "El Paso,TX": [],
    "Washington,DC": ["Washington Commanders", "Washington Nationals", "Washington Wizards", "Washington Capitals"],
    "Boston,MA": ["Boston Celtics", "Boston Bruins", "Boston Red Sox", "New England Patriots"],
    "Detroit,MI": ["Detroit Pistons", "Detroit Lions", "Detroit Tigers", "Detroit Red Wings"],
    "Nashville,TN": ["Tennessee Titans", "Nashville Predators"],
    "Memphis,TN": ["Memphis Grizzlies"],
    "Portland,OR": ["Portland Trail Blazers"],
    "Oklahoma City,OK": ["Oklahoma City Thunder"],
    "Las Vegas,NV": ["Las Vegas Raiders", "Vegas Golden Knights"],
    "Louisville,KY": [],
    "Baltimore,MD": ["Baltimore Ravens", "Baltimore Orioles"],
    "Milwaukee,WI": ["Milwaukee Bucks", "Milwaukee Brewers"],
    "Albuquerque,NM": [],
    "Tucson,AZ": [],
    "Fresno,CA": [],
    "Sacramento,CA": ["Sacramento Kings"],
    "Mesa,AZ": [],
    "Kansas City,MO": ["Kansas City Chiefs", "Kansas City Royals"],
    "Atlanta,GA": ["Atlanta Hawks", "Atlanta Falcons", "Atlanta Braves"],
    "Long Beach,CA": [],
    "Colorado Springs,CO": [],
    "Raleigh,NC": ["Carolina Hurricanes"],
    "Miami,FL": ["Miami Heat", "Miami Dolphins", "Miami Marlins", "Florida Panthers"],
    "Virginia Beach,VA": [],
    "Omaha,NE": [],
    "Oakland,CA": [],
    "Minneapolis,MN": ["Minnesota Timberwolves", "Minnesota Vikings", "Minnesota Twins", "Minnesota Wild"],
    "Tulsa,OK": [],
    "Arlington,TX": ["Dallas Cowboys", "Texas Rangers"],
    "New Orleans,LA": ["New Orleans Pelicans", "New Orleans Saints"],
    "Wichita,KS": []
  };

  const WEATHER_FRESH_MS = 60 * 60 * 1000;
  const WEATHER_STALE_MS = 24 * 60 * 60 * 1000;
  const WEATHER_FETCH_TIMEOUT_MS = 4000;
  const CONCURRENCY = 8;
  const CACHE_VERSION = 5;

  const tooltipEl = document.getElementById('tooltip');

  let _hoverCityKey = null;
  let _lastTooltipPt = null;

  function setHoverState(city, event){
    _hoverCityKey = city ? cityKey(city) : null;
    if(event && event.clientX != null && event.clientY != null) _lastTooltipPt = {clientX: event.clientX, clientY: event.clientY};
  }

  function clearHoverState(){ _hoverCityKey = null; _lastTooltipPt = null; }

  function refreshTooltipIfHovering(city){
    if(!city) return;
    if(!_hoverCityKey || _hoverCityKey !== cityKey(city)) return;
    if(!tooltipEl || tooltipEl.style.display !== "block") return;
    if(!_lastTooltipPt) return;
    showTooltip(_lastTooltipPt, city);
  }

  const refreshBtn = document.getElementById('refreshBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const resetBtn = document.getElementById('resetBtn');
  const locateBtn = document.getElementById('locateBtn');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const playBtn = document.getElementById('playBtn');
  const modeInfoChip = document.getElementById("modeInfoChip");
  const modeSubnote = document.getElementById("modeSubnote");

  const daySlider = document.getElementById('daySlider');
  const dayLabelEl = document.getElementById('dayLabel');
  const colorModeSelect = document.getElementById("colorModeSelect");
  const surfaceToggle = document.getElementById("surfaceToggle");
  const sportsFilterToggle = document.getElementById("sportsFilterToggle");
  const timeMachineToggle = document.getElementById("timeMachineToggle");
  const tmDateWrap = document.getElementById("tmDateWrap");
  const historicalDateInput = document.getElementById("historicalDateInput");
  const spookyThemeToggle = document.getElementById("spookyThemeToggle");
  const upsideDownToggle = document.getElementById("upsideDownToggle");
  const addCityBtn = document.getElementById("addCityBtn");
  const addCityMenuBtn = document.getElementById("addCityMenuBtn");
  const logMemoryBtn = document.getElementById("logMemoryBtn");
  const memoryFormWrap = document.getElementById("memoryFormWrap");
  const memoryForm = document.getElementById("memoryForm");
  const memoryCitySelect = document.getElementById("memoryCitySelect");
  const memoryDateInput = document.getElementById("memoryDateInput");
  const memoryNoteInput = document.getElementById("memoryNoteInput");
  const memoryCancelBtn = document.getElementById("memoryCancelBtn");
  const memoryJournalModal = document.getElementById("memoryJournalModal");
  const memoryJournalTitle = document.getElementById("memoryJournalTitle");
  const memoryJournalList = document.getElementById("memoryJournalList");
  const memoryJournalClose = document.getElementById("memoryJournalClose");
  const addCityModal = document.getElementById("addCityModal");
  const addCityClose = document.getElementById("addCityClose");
  const addCityCancel = document.getElementById("addCityCancel");
  const addCityForm = document.getElementById("addCityForm");
  const addCityNameInput = document.getElementById("addCityNameInput");
  const addCityStateInput = document.getElementById("addCityStateInput");
  const addCitySubmit = document.getElementById("addCitySubmit");
  const addCityError = document.getElementById("addCityError");
  const addCitySuccess = document.getElementById("addCitySuccess");
  const aqiOptionEl = colorModeSelect ? colorModeSelect.querySelector('option[value="aqi"]') : null;
  const actionMenus = Array.from(document.querySelectorAll("details.actionMenu"));

  let colorMode = "temp";
  let surfaceEnabled = true;
  let selectedHourIndex = 0; 
  let isPlaying = false;
  let playInterval = null;
  let isHistoricalMode = false;
  let historicalStartDate = null;
  let isSpookyMode = false;
  let isUpsideDownMode = false;
  let memoriesData = [];
  let memoriesByCity = new Map();
  let memoryJournalCityKey = null;
  let activeMemoryId = null;
  let isSportsFilterActive = false;
  let sportsScheduleEntries = [];
  let coldestByCity = new Map();
  let coldestMeta = { stale: false, computing: false };
  let coldestPollTimer = null;
  let isSubmittingAddCity = false;
  let userLocation = null;
  const USER_LOCATION_KEY = "userLocation:v1";
  let userLocationTagTimer = null;

  // AQI Color mapping
  function getAQIColor(aqi) {
    if (aqi == null || !isFinite(aqi)) return ERROR_COLOR;
    if (aqi <= 50) return "#10b981"; // Good
    if (aqi <= 100) return "#fbbf24"; // Moderate
    if (aqi <= 150) return "#f97316"; // Unhealthy Sensitive
    if (aqi <= 200) return "#ef4444"; // Unhealthy
    if (aqi <= 300) return "#a855f7"; // Very Unhealthy
    return "#9f1239"; // Hazardous
  }

  function getAQIStatus(aqi) {
    if (aqi == null || !isFinite(aqi)) return {label: "Unknown", color: ERROR_COLOR};
    if (aqi <= 50) return {label: "Good", color: "#10b981"};
    if (aqi <= 100) return {label: "Moderate", color: "#fbbf24"};
    if (aqi <= 150) return {label: "Unhealthy for Sensitive", color: "#f97316"};
    if (aqi <= 200) return {label: "Unhealthy", color: "#ef4444"};
    if (aqi <= 300) return {label: "Very Unhealthy", color: "#a855f7"};
    return {label: "Hazardous", color: "#9f1239"};
  }

  function isoDate(d){
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function addDaysISO(dateStr, days){
    const dt = new Date(`${dateStr}T00:00:00`);
    dt.setDate(dt.getDate() + days);
    return isoDate(dt);
  }

  function getHistoricalStartMaxISO(){
    // Keep historical start conservative to avoid archive lag and keep a full 72h window.
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return isoDate(d);
  }

  function clampHistoricalStart(dateStr){
    const maxISO = getHistoricalStartMaxISO();
    if(!dateStr) return maxISO;
    return (String(dateStr) > maxISO) ? maxISO : String(dateStr);
  }

  function escapeHTML(value){
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function memoryForCityKey(k){
    const arr = memoriesByCity.get(k);
    if(!arr || arr.length === 0) return null;
    return arr[0];
  }

  function memoriesForCityKey(k){
    const arr = memoriesByCity.get(k);
    return Array.isArray(arr) ? arr : [];
  }

  function rebuildMemoriesIndex(){
    const next = new Map();
    for(const m of memoriesData){
      if(!m || !m.city_key) continue;
      if(!next.has(m.city_key)) next.set(m.city_key, []);
      next.get(m.city_key).push(m);
    }
    for(const [k, arr] of next.entries()){
      arr.sort((a, b) => String(b.memory_date || "").localeCompare(String(a.memory_date || "")));
      next.set(k, arr);
    }
    memoriesByCity = next;
  }

  function setMemoryJournalVisible(show){
    if(!memoryJournalModal) return;
    memoryJournalModal.hidden = !show;
    if(!show){
      memoryJournalCityKey = null;
    }
  }

  function renderMemoryJournal(cityKeyValue){
    if(!memoryJournalTitle || !memoryJournalList) return;
    const rows = memoriesForCityKey(cityKeyValue);
    const label = String(cityKeyValue || "").replace(",", ", ");
    memoryJournalTitle.textContent = `Memories in ${label}`;
    memoryJournalList.innerHTML = rows.map((m) => {
      const rowId = Number(m.id);
      return `<div class="memoryRow" data-id="${rowId}"><div><div class="memoryRowDate">${escapeHTML(m.memory_date)}</div><div class="memoryRowNote">${escapeHTML(m.note || "")}</div></div><div class="memoryRowActions"><button class="memoryRevisitBtn" data-action="revisit" data-id="${rowId}" type="button">Revisit</button><button class="memoryDeleteBtn" data-action="delete" data-id="${rowId}" type="button">🗑</button></div></div>`;
    }).join("");
    if(rows.length === 0){
      memoryJournalList.innerHTML = `<div class="memoryRow"><div><div class="memoryRowNote">No memories saved.</div></div></div>`;
    }
  }

  function openMemoryJournal(cityKeyValue){
    memoryJournalCityKey = cityKeyValue;
    renderMemoryJournal(cityKeyValue);
    setMemoryJournalVisible(true);
  }

  async function deleteMemoryById(id){
    const memoryId = Number(id);
    if(!Number.isInteger(memoryId) || memoryId <= 0) return;
    const res = await fetch(`/api/memories/${memoryId}`, { method: "DELETE" });
    if(!res.ok){
      throw new Error(`delete memory HTTP ${res.status}`);
    }
    memoriesData = memoriesData.filter((m) => Number(m.id) !== memoryId);
    rebuildMemoriesIndex();
    updateMemoryStars();
    renderPinnedPanel();
    if(memoryJournalCityKey){
      const left = memoriesForCityKey(memoryJournalCityKey);
      if(left.length === 0){
        setMemoryJournalVisible(false);
      } else {
        renderMemoryJournal(memoryJournalCityKey);
      }
    }
    if(activeMemoryId === memoryId && !isUpsideDownMode){
      activeMemoryId = null;
      await setHistoricalMode(false);
    }
  }

  async function fetchMemories(){
    try{
      const res = await fetch("/api/memories", { cache: "no-store" });
      if(!res.ok) throw new Error(`memories HTTP ${res.status}`);
      const rows = await res.json();
      memoriesData = Array.isArray(rows) ? rows : [];
      rebuildMemoriesIndex();
      updateMemoryStars();
    } catch(e){
      console.error(e);
      setStatus("Memory API unavailable. Running weather-only mode.");
    }
  }

  async function fetchSportsSchedules(){
    const feeds = [
      { league: "NFL", emoji: "🏈", url: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" },
      { league: "NBA", emoji: "🏀", url: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard" },
      { league: "MLB", emoji: "⚾", url: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard" },
      { league: "NHL", emoji: "🏒", url: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard" }
    ];

    const fmtET = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit"
    });

    const settled = await Promise.allSettled(
      feeds.map(async (f) => {
        const res = await fetch(f.url, { cache: "no-store" });
        if(!res.ok) throw new Error(`${f.league} HTTP ${res.status}`);
        const json = await res.json();
        return { feed: f, data: json };
      })
    );

    const all = [];
    for(const item of settled){
      if(item.status !== "fulfilled") continue;
      const { feed, data } = item.value;
      const events = Array.isArray(data?.events) ? data.events : [];
      for(const ev of events){
        const comp = ev?.competitions?.[0];
        const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
        const home = competitors.find((c) => c?.homeAway === "home");
        const away = competitors.find((c) => c?.homeAway === "away");
        if(!home || !away) continue;

        const homeTeam = home?.team || {};
        const awayTeam = away?.team || {};
        const homeName = String(homeTeam.displayName || homeTeam.shortDisplayName || homeTeam.name || "").trim();
        const awayName = String(awayTeam.displayName || awayTeam.shortDisplayName || awayTeam.name || "").trim();
        if(!homeName || !awayName) continue;

        const names = (t) => [t.displayName, t.shortDisplayName, t.name, t.abbreviation]
          .filter(Boolean).map((s) => String(s).toLowerCase());
        let timeET = "";
        try { timeET = fmtET.format(new Date(ev?.date)); } catch { timeET = ""; }

        all.push({
          league: feed.league,
          emoji: feed.emoji,
          away: awayName,
          home: homeName,
          timeET,
          awayNames: names(awayTeam),
          homeNames: names(homeTeam)
        });
      }
    }

    sportsScheduleEntries = all;
    if(isSportsFilterActive){
      renderPinnedPanel();
      if(_hoverCityKey && _lastTooltipPt){
        const city = activeCities.find((c) => cityKey(c) === _hoverCityKey);
        if(city) showTooltip(_lastTooltipPt, city);
      }
    }
  }

  function gamesForCityKey(cityKeyValue){
    if(!isSportsFilterActive) return [];
    const teams = SPORTS_DICTIONARY[cityKeyValue] || [];
    if(!teams.length || !sportsScheduleEntries.length) return [];
    const normalizeTeam = (s) => String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const teamSet = new Set(teams.map(normalizeTeam));
    return sportsScheduleEntries.filter((g) => {
      const matchIn = (arr) => arr.some((n) => teamSet.has(normalizeTeam(n)));
      return matchIn(g.homeNames || []) || matchIn(g.awayNames || []);
    });
  }

  function sportsBlockHTML(cityKeyValue){
    const games = gamesForCityKey(cityKeyValue);
    if(games.length === 0) return "";
    const byLeague = new Map();
    for(const g of games){
      const key = String(g.league || "Other");
      if(!byLeague.has(key)) byLeague.set(key, []);
      byLeague.get(key).push(g);
    }
    const groups = Array.from(byLeague.entries()).map(([league, list]) => {
      const rows = list.map((g) => `<div class="tooltip-sports-row"><span class="tooltip-sports-match">${g.emoji} ${escapeHTML(g.away)} @ ${escapeHTML(g.home)}</span><span class="tooltip-sports-time">${escapeHTML(g.timeET)} ET</span></div>`).join("");
      return `<div class="tooltip-sports-group"><div class="tooltip-sports-league">${escapeHTML(league)}</div>${rows}</div>`;
    }).join("");
    return `<div class="divider"></div><div class="secTitle">Game Day</div><div class="tooltip-sports-list">${groups}</div>`;
  }

  function applyColdestToActiveCities(){
    for(const city of activeCities){
      city._coldest5y = coldestByCity.get(cityKey(city)) || null;
    }
  }

  async function fetchColdestDays(){
    try{
      if(coldestPollTimer){ clearTimeout(coldestPollTimer); coldestPollTimer = null; }
      const res = await fetch("/api/coldest-days?window=5y", { cache: "no-store" });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      coldestByCity = new Map();
      for(const r of rows){
        const key = String(r?.city_key || "").trim();
        if(!key) continue;
        const low = Number(r?.coldest_low_f);
        coldestByCity.set(key, {
          date: r?.coldest_date || null,
          low: Number.isFinite(low) ? low : null,
          source: "archive_5y",
          window_start: r?.window_start || null,
          window_end: r?.window_end || null
        });
      }
      coldestMeta = {
        stale: !!payload?.stale,
        computing: !!payload?.computing
      };
      applyColdestToActiveCities();
      updateModeUXHints();
      if(colorMode === "coldest"){
        computeScaleFromLoaded(true);
        if(_hoverCityKey && _lastTooltipPt){
          const city = activeCities.find((c) => cityKey(c) === _hoverCityKey);
          if(city) showTooltip(_lastTooltipPt, city);
        }
      }
      const shouldPoll = (!!payload?.computing) || rows.length < TOP_CITIES.length;
      if(shouldPoll){
        coldestPollTimer = setTimeout(() => { fetchColdestDays().catch(() => {}); }, 15000);
      }
    } catch (err){
      coldestByCity = new Map();
      coldestMeta = { stale: false, computing: false };
      updateModeUXHints();
    }
  }

  function normalizeCityName(v){
    return String(v || "").trim().replace(/\s+/g, " ");
  }

  function cityIdentityKey(city, state){
    return `${normalizeCityName(city).toLowerCase()}|${String(state || "").trim().toUpperCase()}`;
  }

  function coerceCityRow(raw){
    const city = normalizeCityName(raw?.city);
    const state = String(raw?.state || "").trim().toUpperCase();
    const lat = Number(raw?.lat);
    const lon = Number(raw?.lon);
    const pop = Number(raw?.pop);
    if(!city || !/^[A-Z]{2}$/.test(state)) return null;
    if(!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if(!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    return {
      city,
      state,
      lat,
      lon,
      pop: Number.isFinite(pop) && pop >= 0 ? Math.round(pop) : 0
    };
  }

  function setAddCityMessage(el, msg){
    if(!el) return;
    const txt = String(msg || "").trim();
    el.hidden = !txt;
    el.textContent = txt;
  }

  function setAddCitySubmitting(next){
    isSubmittingAddCity = !!next;
    if(addCitySubmit){
      addCitySubmit.disabled = isSubmittingAddCity;
      addCitySubmit.textContent = isSubmittingAddCity ? "Adding..." : "Add City";
    }
  }

  function setAddCityModalVisible(show){
    if(!addCityModal) return;
    addCityModal.hidden = !show;
    if(show){
      setAddCityMessage(addCityError, "");
      setAddCityMessage(addCitySuccess, "");
      setTimeout(() => { if(addCityNameInput) addCityNameInput.focus(); }, 0);
    } else {
      setAddCitySubmitting(false);
    }
  }

  function rebindPinnedCities(){
    const next = new Map();
    for(const k of pinned.keys()){
      const found = activeCities.find((c) => cityKey(c) === k);
      if(found) next.set(k, found);
    }
    pinned.clear();
    for(const [k, v] of next.entries()) pinned.set(k, v);
    if(focusedKey && !activeCities.some((c) => cityKey(c) === focusedKey)) focusedKey = null;
    if(pendingFocusKey && !activeCities.some((c) => cityKey(c) === pendingFocusKey)) pendingFocusKey = null;
    savePinned();
  }

  async function fetchTopCitiesCatalog(){
    try{
      const res = await fetch("/api/cities", { cache: "no-store" });
      if(!res.ok) throw new Error(`cities HTTP ${res.status}`);
      const payload = await res.json();
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const parsed = rows.map(coerceCityRow).filter(Boolean);
      if(parsed.length) TOP_CITIES = parsed;
    } catch(err){
      TOP_CITIES = CITIES.map((c) => ({ ...c }));
    }
    if(!isSpookyMode){
      activeCities = TOP_CITIES;
      applyColdestToActiveCities();
      rebindPinnedCities();
      populateMemoryCityOptions();
    }
  }

  function validateAddCityForm(){
    const city = normalizeCityName(addCityNameInput?.value);
    const state = String(addCityStateInput?.value || "").trim().toUpperCase();

    if(!city) return { error: "City is required." };
    if(!/^[A-Z]{2}$/.test(state)) return { error: "State must be a 2-letter code (for example NY)." };

    const key = cityIdentityKey(city, state);
    const alreadyExists = TOP_CITIES.some((c) => cityIdentityKey(c.city, c.state) === key);
    if(alreadyExists) return { error: "That city is already on the map." };

    return {
      value: {
        city,
        state
      }
    };
  }

  async function submitAddCity(){
    if(isSubmittingAddCity) return;
    const checked = validateAddCityForm();
    if(checked.error){
      setAddCityMessage(addCitySuccess, "");
      setAddCityMessage(addCityError, checked.error);
      return;
    }

    setAddCityMessage(addCityError, "");
    setAddCityMessage(addCitySuccess, "");
    setAddCitySubmitting(true);
    try{
      const res = await fetch("/api/cities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checked.value)
      });
      const payload = await res.json().catch(() => ({}));
      if(!res.ok){
        const msg = String(payload?.error || `Could not add city (HTTP ${res.status}).`);
        setAddCityMessage(addCityError, msg);
        return;
      }

      setAddCityMessage(addCitySuccess, "City added. Loading weather and coldest data...");
      if(addCityForm) addCityForm.reset();
      await fetchTopCitiesCatalog();
      if(!isSpookyMode && cachedUSMap){
        render(cachedUSMap);
        await loadAllWeather({ force: true });
        if(colorMode === "aqi" && !isHistoricalMode) loadAllAQI();
      }
      fetchColdestDays().catch(() => {});
      setTimeout(() => setAddCityModalVisible(false), 350);
      setStatus("City added to map. Forecast data is loading.");
    } catch (err){
      setAddCityMessage(addCityError, "Could not save city. Please try again.");
    } finally {
      setAddCitySubmitting(false);
    }
  }

  function populateMemoryCityOptions(){
    if(!memoryCitySelect) return;
    const options = TOP_CITIES
      .slice()
      .sort((a,b) => a.city.localeCompare(b.city))
      .map(c => {
        const key = `${c.city},${c.state}`;
        return `<option value="${escapeHTML(key)}">${escapeHTML(c.city)}, ${escapeHTML(c.state)}</option>`;
      }).join("");
    memoryCitySelect.innerHTML = options;
  }

  function setMemoryFormVisible(show){
    if(!memoryFormWrap) return;
    memoryFormWrap.hidden = !show;
    if(show && memoryCitySelect && !memoryCitySelect.value && memoryCitySelect.options.length){
      memoryCitySelect.selectedIndex = 0;
    }
  }

  async function submitMemory(){
    if(!memoryCitySelect || !memoryDateInput || !memoryNoteInput) return;
    const city_key = String(memoryCitySelect.value || "").trim();
    const memory_date = String(memoryDateInput.value || "").trim();
    const note = String(memoryNoteInput.value || "").trim();
    if(!city_key || !memory_date || !note){
      setStatus("Please complete City, Date, and Note.");
      return;
    }
    const maxHist = getHistoricalStartMaxISO();
    if(memory_date > maxHist){
      setStatus(`Pick a date on or before ${maxHist} for archive-backed memories.`);
      return;
    }
    const res = await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city_key, memory_date, note })
    });
    if(!res.ok){
      throw new Error(`save memory HTTP ${res.status}`);
    }
    const saved = await res.json();
    memoriesData.push(saved);
    rebuildMemoriesIndex();
    updateMemoryStars();
    if(memoryJournalCityKey === city_key){
      renderMemoryJournal(city_key);
    }
    setMemoryFormVisible(false);
    memoryNoteInput.value = "";
    setStatus("Memory saved.");
  }

  function updateMemoryStars(){
    if(!gCities) return;
    gCities.selectAll("g.city text.memory-star")
      .style("display", d => memoriesByCity.has(cityKey(d)) ? null : "none");
  }

  async function jumpToMemoryDate(memory){
    if(!memory || !memory.memory_date) return;
    if (isPlaying) { isPlaying = false; if(playBtn) playBtn.textContent = "▶️"; clearInterval(playInterval); }
    isHistoricalMode = true;
    const safeDate = clampHistoricalStart(memory.memory_date);
    historicalStartDate = safeDate;
    if(timeMachineToggle && !timeMachineToggle.disabled){
      timeMachineToggle.checked = true;
    }
    if(tmDateWrap) tmDateWrap.hidden = false;
    if(historicalDateInput){
      historicalDateInput.value = safeDate;
    }
    if(safeDate !== memory.memory_date){
      setStatus(`Memory date adjusted to ${safeDate} due archive availability window.`);
    }
    activeMemoryId = Number(memory.id) || null;
    setAQIOptionEnabled(false);
    selectedHourIndex = 0;
    if(daySlider) daySlider.value = "0";
    await loadAllWeather({ force: true });
  }

  function clearAQIData(){
    for(const city of activeCities){
      city._aqi = undefined;
      city._aqiLoading = false;
    }
  }

  function setAQIOptionEnabled(enabled){
    if(aqiOptionEl) aqiOptionEl.disabled = !enabled;
    if(colorModeSelect && colorMode === "aqi" && !enabled){
      colorMode = "temp";
      colorModeSelect.value = "temp";
      computeScaleFromLoaded(true);
      updateDayLabelUI();
      updateModeUXHints();
      schedulePermalinkUpdate();
    }
  }

  function initHistoricalDateInput(){
    if(!historicalDateInput) return;
    const maxISO = getHistoricalStartMaxISO();
    historicalDateInput.max = maxISO;
    if(!historicalStartDate || historicalStartDate > maxISO){
      historicalStartDate = maxISO;
    }
    historicalDateInput.value = historicalStartDate;
  }

  function applyThemeAttribute(){
    if(isUpsideDownMode){
      document.body.setAttribute("data-theme", "upside-down");
      return;
    }
    if(isSpookyMode){
      document.body.setAttribute("data-theme", "spooky");
      return;
    }
    document.body.removeAttribute("data-theme");
  }

  function runThemeTransition(nextUpsideState){
    const enteringUpside = !!nextUpsideState;
    document.body.classList.remove("theme-transition-upside-enter", "theme-transition-upside-exit");
    document.body.classList.add("theme-transition", enteringUpside ? "theme-transition-upside-enter" : "theme-transition-upside-exit");
    setTimeout(() => {
      document.body.classList.remove("theme-transition", "theme-transition-upside-enter", "theme-transition-upside-exit");
    }, 1100);
  }

  async function setHistoricalMode(nextMode){
    isHistoricalMode = !!nextMode;
    if(!isHistoricalMode) activeMemoryId = null;
    if(tmDateWrap) tmDateWrap.hidden = !isHistoricalMode;
    setAQIOptionEnabled(!isHistoricalMode);

    if(isHistoricalMode){
      initHistoricalDateInput();
      clearAQIData();
      selectedHourIndex = 0;
      if(daySlider) daySlider.value = "0";
      await loadAllWeather({ force: true });
    } else {
      selectedHourIndex = 0;
      if(daySlider) daySlider.value = "0";
      await loadAllWeather({ force: true });
      if(colorMode === "aqi") loadAllAQI();
    }
  }

  function clearPinsAndFocus(){
    pinned.clear();
    focusedKey = null;
    pendingFocusKey = null;
    savePinned();
    renderPinnedPanel();
    updatePinnedStyles();
    applyFocusStyles();
  }

  async function setSpookyMode(nextMode){
    isSpookyMode = !!nextMode;
    if(isSpookyMode){
      activeCities = HORROR_CITIES;
    } else {
      activeCities = TOP_CITIES;
    }
    applyColdestToActiveCities();
    applyThemeAttribute();
    clearPinsAndFocus();
    clearAQIData();
    selectedHourIndex = 0;
    if(daySlider) daySlider.value = "0";
    if(cachedUSMap) render(cachedUSMap);
    schedulePermalinkUpdate();
    await loadAllWeather({ force: true });
    if(colorMode === "aqi" && !isHistoricalMode){
      loadAllAQI();
    }
  }

  async function setUpsideDownMode(nextMode){
    isUpsideDownMode = !!nextMode;
    if(upsideDownToggle) upsideDownToggle.checked = isUpsideDownMode;
    runThemeTransition(isUpsideDownMode);
    applyThemeAttribute();

    // Upside Down is a visual/UX mode; do not force historical weather.
    if(timeMachineToggle){
      timeMachineToggle.disabled = false;
      timeMachineToggle.checked = !!isHistoricalMode;
    }
    if(tmDateWrap){
      tmDateWrap.hidden = !isHistoricalMode;
    }
    if(historicalDateInput){
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() - 7);
      historicalDateInput.max = isoDate(maxDate);
      if(isHistoricalMode && historicalStartDate){
        historicalDateInput.value = historicalStartDate;
      }
    }
    setAQIOptionEnabled(!isHistoricalMode);

    clearAQIData();
    selectedHourIndex = 0;
    if(daySlider) daySlider.value = "0";
    schedulePermalinkUpdate();
    await loadAllWeather({ force: true });
    if(colorMode === "aqi" && !isHistoricalMode){
      loadAllAQI();
    }
  }

  if(colorModeSelect){
    colorModeSelect.addEventListener("change", () => {
      colorMode = colorModeSelect.value || "temp";
      if(colorMode === "aqi") loadAllAQI();
      updateDayLabelUI();
      updateModeUXHints();
      computeScaleFromLoaded(true);
      updatePinnedStyles();
      renderPinnedPanel();
      schedulePermalinkUpdate();
    });
  }
  
  if(surfaceToggle){
    surfaceToggle.addEventListener("change", () => {
      surfaceEnabled = !!surfaceToggle.checked;
      gSurface.style("display", surfaceEnabled ? null : "none");
      computeScaleFromLoaded(false);
      schedulePermalinkUpdate();
    });
  }

  if(sportsFilterToggle){
    sportsFilterToggle.addEventListener("change", async () => {
      isSportsFilterActive = !!sportsFilterToggle.checked;
      if(isSportsFilterActive && sportsScheduleEntries.length === 0){
        try { await fetchSportsSchedules(); } catch(e) { console.error(e); }
      }
      renderPinnedPanel();
      if(_hoverCityKey && _lastTooltipPt){
        const city = activeCities.find((c) => cityKey(c) === _hoverCityKey);
        if(city) showTooltip(_lastTooltipPt, city);
      }
    });
  }

  if(timeMachineToggle){
    timeMachineToggle.addEventListener("change", async () => {
      if (isPlaying) { isPlaying = false; if(playBtn) playBtn.textContent = "▶️"; clearInterval(playInterval); }
      await setHistoricalMode(!!timeMachineToggle.checked);
    });
  }

  if(historicalDateInput){
    historicalDateInput.addEventListener("change", async () => {
      if(!isHistoricalMode) return;
      const nextDate = clampHistoricalStart(historicalDateInput.value);
      if(!nextDate) return;
      if(historicalDateInput.value !== nextDate){
        historicalDateInput.value = nextDate;
      }
      historicalStartDate = nextDate;
      selectedHourIndex = 0;
      if(daySlider) daySlider.value = "0";
      await loadAllWeather({ force: true });
    });
  }

  if(spookyThemeToggle){
    spookyThemeToggle.addEventListener("change", async () => {
      if (isPlaying) { isPlaying = false; if(playBtn) playBtn.textContent = "▶️"; clearInterval(playInterval); }
      await setSpookyMode(!!spookyThemeToggle.checked);
    });
  }

  if(upsideDownToggle){
    upsideDownToggle.addEventListener("change", async () => {
      if (isPlaying) { isPlaying = false; if(playBtn) playBtn.textContent = "▶️"; clearInterval(playInterval); }
      await setUpsideDownMode(!!upsideDownToggle.checked);
    });
  }

  const PERMALINK_VERSION = 2;
  let permalinkReady = false;
  let suppressPermalink = true;
  let pendingZoomState = null;
  let focusedKey = null;
  let pendingFocusKey = null;

  function _clamp(n, lo, hi){ n = +n; return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
  function _clampInt(n, lo, hi, def){ n = parseInt(n, 10); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; }
  function _b64urlEncode(str){ const b64 = btoa(unescape(encodeURIComponent(str))); return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
  function _b64urlDecode(b64url){ const b64 = (b64url || "").replace(/-/g, "+").replace(/_/g, "/"); const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : ""; return decodeURIComponent(escape(atob(b64 + pad))); }

  function encodePermalinkState(obj){ return _b64urlEncode(JSON.stringify(obj)); }
  function decodePermalinkState(str){ try{ return JSON.parse(_b64urlDecode(str)); }catch(e){ return null; } }

  function readPermalinkFromURL(){
    const rawHash = (location.hash || "").replace(/^#/, "");
    if(!rawHash) return null;
    let encoded = null;
    if(rawHash.includes("=")){
      const params = new URLSearchParams(rawHash);
      encoded = params.get("s") || params.get("state");
    } else { encoded = rawHash; }
    if(!encoded) return null;
    return normalizePermalinkState(decodePermalinkState(encoded));
  }

  function normalizePermalinkState(raw){
    if(!raw || typeof raw !== "object") return null;
    const out = { v: PERMALINK_VERSION };
    out.hour = _clampInt(raw.hour || raw.day, 0, 71, 0); // backwards compat
    out.mode = ["temp","precip","aqi","coldest"].includes(raw.mode) ? raw.mode : "temp";
    out.surface = raw.surface ? 1 : 0;
    if(Array.isArray(raw.pins)){ out.pins = raw.pins.filter(k => typeof k === "string" && k.length < 80).slice(0, 50); } else { out.pins = null; }
    if(raw.z && typeof raw.z === "object"){ out.z = { k: _clamp(raw.z.k, 1, 8), x: _clamp(raw.z.x, -5000, 5000), y: _clamp(raw.z.y, -5000, 5000) }; } else { out.z = null; }
    out.focus = (typeof raw.focus === "string" && raw.focus.length < 80) ? raw.focus : null;
    return out;
  }

  function getPermalinkState(){
    const pins = Array.from(pinned.keys());
    const z = lastZoomTransform || d3.zoomIdentity;
    return {
      v: PERMALINK_VERSION, hour: selectedHourIndex, mode: colorMode, surface: surfaceEnabled ? 1 : 0, pins,
      z: { k: z.k, x: z.x, y: z.y }, focus: focusedKey || null
    };
  }

  let _permalinkTimer = null;
  function schedulePermalinkUpdate(){
    if(!permalinkReady || suppressPermalink) return;
    clearTimeout(_permalinkTimer);
    _permalinkTimer = setTimeout(updatePermalinkNow, 160);
  }

  function updatePermalinkNow(){
    if(!permalinkReady || suppressPermalink) return;
    const encoded = encodePermalinkState(getPermalinkState());
    const url = new URL(location.href); url.hash = `s=${encoded}`;
    history.replaceState(null, "", url.toString());
  }

  async function copyPermalinkToClipboard(){
    updatePermalinkNow();
    const txt = location.href;
    try{
      await navigator.clipboard.writeText(txt);
      setStatus("Link copied ✅");
    }catch(e){
      const ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.left = "-9999px"; document.body.appendChild(ta); ta.select();
      try{ document.execCommand("copy"); setStatus("Link copied ✅"); } catch(_){ setStatus("Could not copy link."); }
      document.body.removeChild(ta);
    }
  }

  let lastZoomTransform = d3.zoomIdentity;

  function applyFocusStyles(){
    if(!gCities) return;
    gCities.selectAll("g.city").classed("focused", d => cityKey(d) === focusedKey);
  }

  function applyPinsFromKeys(keys){
    pinned.clear();
    for(const k of keys){
      const city = activeCities.find(d => `${d.city},${d.state}` === k);
      if(city){ pinned.set(k, city); ensureCensus(city); ensureAQI(city); }
    }
    savePinned();
  }

  function applyPermalinkState(st){
    suppressPermalink = true;
    if(typeof st.hour === "number"){ selectedHourIndex = _clampInt(st.hour, 0, 71, 0); if(daySlider) daySlider.value = String(selectedHourIndex); updateDayLabelUI(); }
    if(st.mode){ colorMode = st.mode; if(colorModeSelect) colorModeSelect.value = colorMode; }
    updateModeUXHints();
    if(typeof st.surface === "number"){ surfaceEnabled = !!st.surface; if(surfaceToggle) surfaceToggle.checked = surfaceEnabled; gSurface.style("display", surfaceEnabled ? null : "none"); }
    if(st.pins) applyPinsFromKeys(st.pins);
    if(st.focus){ focusedKey = st.focus; pendingFocusKey = st.focus; }
    if(st.z){ pendingZoomState = st.z; lastZoomTransform = d3.zoomIdentity.translate(st.z.x, st.z.y).scale(st.z.k); }
    suppressPermalink = false;
  }

  function applyPendingZoomIfAny(){
    if(!pendingZoomState || !zoom) return;
    const t = d3.zoomIdentity.translate(pendingZoomState.x, pendingZoomState.y).scale(pendingZoomState.k);
    svg.call(zoom.transform, t); pendingZoomState = null;
  }

  const legendTagEl = document.getElementById('legendTag');
  const pinnedPanelEl = document.getElementById('pinnedPanel');
  const pinnedListEl = document.getElementById('pinnedList');
  const pinnedHintEl = document.getElementById("pinnedHint");

  const svg = d3.select("#map");
  const gRoot = svg.append("g").attr("class", "root");
  const defs = svg.append("defs");
  const landClip = defs.append("clipPath").attr("id", "land-clip");
  const landClipPath = landClip.append("path");
  const gLand = gRoot.append("g").attr("class", "land");
  const gTerrain = gRoot.append("g").attr("class", "terrain-fx").attr("clip-path", "url(#land-clip)");
  const gSurface = gRoot.append("g").attr("class", "surface").attr("clip-path", "url(#land-clip)");
  const gBorders = gRoot.append("g").attr("class", "borders");
  const gRifts = gRoot.append("g").attr("class", "rift-overlay").attr("clip-path", "url(#land-clip)");
  const gCities = gRoot.append("g").attr("class", "cities");
  const gClusters = gRoot.append("g").attr("class", "clusters");
  const gUserLocation = gRoot.append("g").attr("class", "user-location-layer");

  let projection = d3.geoAlbersUsa();
  let path = d3.geoPath(projection);
  let zoom;
  let mapWidth = 0; let mapHeight = 0;
  let cachedUSMap = null;
  const SURFACE_CELL_PX = 12;
  let lastTouchCityKey = null;
  let lastTouchTs = 0;

  function weatherCacheScope(){
    const themeScope = isUpsideDownMode ? "upside" : (isSpookyMode ? "spooky" : "default");
    if(isHistoricalMode){
      return `${themeScope}:hist:${historicalStartDate || "unset"}`;
    }
    return `${themeScope}:live`;
  }

  function cacheKey(city) { return `wxv${CACHE_VERSION}:${weatherCacheScope()}:${city.city},${city.state}`; }

  function readCache(city) {
    try {
      const raw = localStorage.getItem(cacheKey(city));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.fetchedAt) return null;
      if (Date.now() - obj.fetchedAt > WEATHER_STALE_MS) return null;
      const { fetchedAt, ...payload } = obj; return { payload, fetchedAt };
    } catch { return null; }
  }

  function writeCache(city, payload, fetchedAt = Date.now()) {
    try { localStorage.setItem(cacheKey(city), JSON.stringify({ ...payload, fetchedAt })); } catch {}
  }

  async function fetchJSONWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { "Accept": "application/json" }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`Fetch failed (${res.status})`); return await res.json();
    } finally { clearTimeout(t); }
  }

  async function fetchWeatherNetwork(city) {
    const useHistorical = isHistoricalMode && !!historicalStartDate;
    let url = "";
    if(useHistorical){
      const endDate = addDaysISO(historicalStartDate, 2);
      url =
        `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}` +
        `&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
        `&start_date=${historicalStartDate}&end_date=${endDate}` +
        `&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    } else {
      url =
        `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
        `&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&forecast_days=3&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    }

    const data = await fetchJSONWithTimeout(url, WEATHER_FETCH_TIMEOUT_MS);
    const cur = data?.current ?? {};
    const hourlyTime = data?.hourly?.time ?? [];
    const hourlyTemp = data?.hourly?.temperature_2m ?? [];
    const hourlyCode = data?.hourly?.weather_code ?? [];
    const hourlyWindSpeed = data?.hourly?.wind_speed_10m ?? [];
    const hourlyWindDir = data?.hourly?.wind_direction_10m ?? [];
    const hourlyPrecip = useHistorical
      ? (data?.hourly?.precipitation ?? [])
      : (data?.hourly?.precipitation_probability ?? []);

    const currentTime = cur?.time ?? hourlyTime?.[0] ?? null;
    const currentTemp = cur?.temperature_2m ?? hourlyTemp?.[0] ?? null;
    const currentCode = cur?.weather_code ?? hourlyCode?.[0] ?? null;
    const currentWindSpeed = cur?.wind_speed_10m ?? hourlyWindSpeed?.[0] ?? null;
    const currentWindDir = cur?.wind_direction_10m ?? hourlyWindDir?.[0] ?? null;
    const dailyDates = data?.daily?.time ?? [];
    const dailyLows = data?.daily?.temperature_2m_min ?? [];
    let coldestIdx = -1;
    let coldestLow = null;
    for(let i = 0; i < dailyLows.length; i++){
      const v = dailyLows[i];
      if(v == null || !isFinite(v)) continue;
      if(coldestIdx < 0 || v < coldestLow){
        coldestIdx = i;
        coldestLow = Number(v);
      }
    }
    const coldestDay = (coldestIdx >= 0)
      ? { date: dailyDates[coldestIdx] ?? null, low: coldestLow, source: "loaded_window" }
      : { date: null, low: null, source: "loaded_window" };

    return {
      dates: [dailyDates?.[0] ?? null, dailyDates?.[1] ?? null, dailyDates?.[2] ?? null],
      hi:    [data?.daily?.temperature_2m_max?.[0] ?? null, data?.daily?.temperature_2m_max?.[1] ?? null, data?.daily?.temperature_2m_max?.[2] ?? null],
      lo:    [data?.daily?.temperature_2m_min?.[0] ?? null, data?.daily?.temperature_2m_min?.[1] ?? null, data?.daily?.temperature_2m_min?.[2] ?? null],
      precip: useHistorical
        ? [data?.daily?.precipitation_sum?.[0] ?? null, data?.daily?.precipitation_sum?.[1] ?? null, data?.daily?.precipitation_sum?.[2] ?? null]
        : [data?.daily?.precipitation_probability_max?.[0] ?? null, data?.daily?.precipitation_probability_max?.[1] ?? null, data?.daily?.precipitation_probability_max?.[2] ?? null],
      coldestDay,
      current: {
        time: currentTime, temp: currentTemp, feels: cur?.apparent_temperature ?? currentTemp,
        humidity: cur?.relative_humidity_2m ?? null, cloud: cur?.cloud_cover ?? null, code: currentCode,
        windSpeed: currentWindSpeed, windDir: currentWindDir, windGust: cur?.wind_gusts_10m ?? null
      },
      hourly: {
        time: hourlyTime, temp: hourlyTemp,
        precip: hourlyPrecip, code: hourlyCode,
        windSpeed: hourlyWindSpeed, windDir: hourlyWindDir
      }
    };
  }

  async function fetchAQINetwork(city) {
    const url = `https://api.waqi.info/feed/geo:${city.lat};${city.lon}/?token=${WAQI_TOKEN}`;
    const data = await fetchJSONWithTimeout(url, WEATHER_FETCH_TIMEOUT_MS);
    if (data && data.status === "ok" && data.data) {
      let aqiVal = data.data.aqi;
      if (aqiVal === "-") aqiVal = null; else aqiVal = Number(aqiVal);
      return { aqi: aqiVal, primary: data.data.dominentpol || null };
    }
    return null;
  }

  function ensureAQI(city) {
    if(isHistoricalMode) return;
    if(!city || city._aqi !== undefined || city._aqiLoading) return;
    city._aqiLoading = true;
    fetchAQINetwork(city).then(res => {
      city._aqi = res; city._aqiLoading = false;
      refreshTooltipIfHovering(city);
      if (pinned.has(cityKey(city))) renderPinnedPanel();
      if (colorMode === "aqi") computeScaleFromLoaded(true);
    }).catch(e => { city._aqi = null; city._aqiLoading = false; });
  }

  let isFetchingAQI = false;
  async function loadAllAQI() {
    if(isHistoricalMode) return;
    if(isFetchingAQI) return;
    isFetchingAQI = true;
    setStatus(`Fetching live Air Quality data…`);
    setProgress(0, activeCities.length, 0);
    let done = 0;
    await asyncPool(CONCURRENCY, activeCities, async (city) => {
      if (city._aqi === undefined) { try { city._aqi = await fetchAQINetwork(city); } catch(e) { city._aqi = null; } }
      done++; setProgress(done, activeCities.length, 0); computeScaleFromLoaded(true);
    });
    setStatus(`Updated map with Live AQI.`);
    isFetchingAQI = false;
  }

  function shouldRefreshFromNetwork(city) {
    const m = city?._wxMeta;
    if (!m || m.source !== "cache" || !m.fetchedAt) return true;
    return (Date.now() - m.fetchedAt) > WEATHER_FRESH_MS;
  }

  function formatAgeShort(ageMs) {
    const mins = Math.max(0, Math.round(ageMs / 60000));
    if (mins < 60) return `${mins}m`; const h = Math.floor(mins / 60); const m = mins % 60; return (m === 0) ? `${h}h` : `${h}h ${m}m`;
  }

  function weatherBadgeHTML(city) {
    const m = city?._wxMeta;
    if (!m || !m.source) return "";
    if (m.source === "live") return `<span class="chip badge live">🟢 Live</span>`;
    if (m.source === "cache") {
      if (!m.fetchedAt) return `<span class="chip badge cache">🗃️ Cached</span>`;
      const ageMs = Date.now() - m.fetchedAt; return `<span class="chip badge cache">🗃️ Cached (${formatAgeShort(ageMs)} old)</span>`;
    }
    return `<span class="chip badge none">⚪ No data</span>`;
  }

  function degToCompass(deg){
    if(deg == null || !isFinite(deg)) return "—";
    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return dirs[Math.round(((deg % 360) / 22.5)) % 16];
  }

  function wxCodeToIconLabel(code){
    const c = (code == null) ? null : Number(code);
    if(c === null || !isFinite(c)) return {icon:"❔", label:"Unknown"};
    if(c === 0) return {icon:"☀️", label:"Clear"};
    if(c === 1) return {icon:"🌤️", label:"Mostly clear"};
    if(c === 2) return {icon:"⛅", label:"Partly cloudy"};
    if(c === 3) return {icon:"☁️", label:"Overcast"};
    if(c === 45 || c === 48) return {icon:"🌫️", label:"Fog"};
    if([51,53,55,56,57].includes(c)) return {icon:"🌦️", label:"Drizzle"};
    if([61,63,65,66,67].includes(c)) return {icon:"🌧️", label:"Rain"};
    if([71,73,75,77].includes(c)) return {icon:"🌨️", label:"Snow"};
    if([80,81,82].includes(c)) return {icon:"🌦️", label:"Showers"};
    if([85,86].includes(c)) return {icon:"🌨️", label:"Snow showers"};
    if(c === 95) return {icon:"⛈️", label:"Thunderstorm"};
    if(c === 96 || c === 99) return {icon:"⛈️", label:"Thunderstorm (hail)"};
    return {icon:"🌡️", label:`Code ${c}`};
  }

  function fmtNum(v, digits=0){ return (v == null || !isFinite(v)) ? "—" : Number(v).toFixed(digits); }
  function fmtInt(v){ return (v == null || !isFinite(v)) ? "—" : String(Math.round(Number(v))); }

  const ACS_YEAR = 2023;
  const CENSUS_BASE = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5/profile`;
  const CENSUS_SOURCE_TITLE = `Source: U.S. Census Bureau — American Community Survey (ACS) 5-year Data Profile (${ACS_YEAR}). Fields: DP02_0068PE (Bachelor’s degree or higher, age 25+ %), DP03_0062E (Median household income).`;

  const STATE_FIPS = { AL:"01", AK:"02", AZ:"04", AR:"05", CA:"06", CO:"08", CT:"09", DE:"10", DC:"11", FL:"12", GA:"13", HI:"15", ID:"16", IL:"17", IN:"18", IA:"19", KS:"20", KY:"21", LA:"22", ME:"23", MD:"24", MA:"25", MI:"26", MN:"27", MS:"28", MO:"29", MT:"30", NE:"31", NV:"32", NH:"33", NJ:"34", NM:"35", NY:"36", NC:"37", ND:"38", OH:"39", OK:"40", OR:"41", PA:"42", RI:"44", SC:"45", SD:"46", TN:"47", TX:"48", UT:"49", VT:"50", VA:"51", WA:"53", WV:"54", WI:"55", WY:"56" };
  const CENSUS_PLACES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CENSUS_CITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function censusPlacesKey(stateFips){ return `census:places:v2:${ACS_YEAR}:${stateFips}`; }
  function censusCityKey(stateFips, placeFips){ return `census:city:${ACS_YEAR}:${stateFips}:${placeFips}`; }

  function normBasic(s){ return String(s ?? "").toLowerCase().replace(/[\u2019']/g, "").replace(/[^a-z0-9\/\-\s]/g, " ").replace(/\s+/g, " ").trim(); }
  function normPlaceLabel(label){
    let s = String(label ?? ""); s = s.replace(/\s*\(balance\)\s*$/i, ""); s = s.replace(/\s*\(.*?\)\s*$/i, (m) => m.toLowerCase().includes("balance") ? "" : m);
    s = s.replace(/\s*city\s*$/i, ""); s = s.replace(/\s*town\s*$/i, ""); s = s.replace(/\s*village\s*$/i, ""); s = s.replace(/\s*borough\s*$/i, "");
    s = s.replace(/\s*municipio\s*$/i, ""); s = s.replace(/\s*metropolitan government\s*$/i, ""); s = s.replace(/\s*metro government\s*$/i, "");
    s = s.replace(/\s*unified government\s*$/i, ""); s = s.replace(/\s*government\s*$/i, ""); return normBasic(s);
  }
  function fmtPct1(v){ return (v == null || !isFinite(v)) ? "—" : `${Number(v).toFixed(1)}%`; }
  function fmtUSD(v){ if(v == null || !isFinite(v)) return "—"; try { return new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(Number(v)); } catch { return `$${Math.round(Number(v)).toLocaleString("en-US")}`; } }
  function fmtUSDCompact(v){
    if(v == null || !isFinite(v)) return "—"; const n = Number(v);
    try { return new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", notation:"compact", compactDisplay:"short", maximumFractionDigits:1 }).format(n); } 
    catch { if(n >= 1e6) return `$${(n/1e6).toFixed(1)}M`; if(n >= 1e3) return `$${(n/1e3).toFixed(1)}K`; return fmtUSD(n); }
  }
  function readLS(key){ try { const raw = localStorage.getItem(key); if(!raw) return null; return JSON.parse(raw); } catch { return null; } }
  function writeLS(key, obj){ try { localStorage.setItem(key, JSON.stringify(obj)); } catch {} }

  async function ensurePlaceIndex(stateFips){
    const key = censusPlacesKey(stateFips); const cached = readLS(key);
    if(cached && cached.ts && (Date.now() - cached.ts) < CENSUS_PLACES_TTL_MS && Array.isArray(cached.entries)){ return cached.entries; }
    const url = `${CENSUS_BASE}?get=NAME&for=place:*&in=state:${stateFips}`;
    const rows = await fetchJsonWithTimeout(url, 20000); const entries = [];
    for(let i=1;i<rows.length;i++){ const r = rows[i]; const name = r[0]; const place = r[2]; const label = String(name).split(",")[0]; const k = normPlaceLabel(label); if(k && place) entries.push([k, place, name]); }
    writeLS(key, {ts: Date.now(), entries}); return entries;
  }

  function pickBestPlace(entries, cityName){
    const cityKey = normBasic(cityName); if(!cityKey) return null;
    let exact = entries.find(e => e[0] === cityKey); if(exact) return exact;
    const candidates = entries.filter(e => e[0].startsWith(cityKey) || cityKey.startsWith(e[0]) || e[0].includes(cityKey));
    if(candidates.length === 0) return null;
    candidates.sort((a,b) => {
      const aSW = a[0].startsWith(cityKey) ? 0 : 1; const bSW = b[0].startsWith(cityKey) ? 0 : 1; if(aSW !== bSW) return aSW - bSW;
      const da = Math.abs(a[0].length - cityKey.length); const db = Math.abs(b[0].length - cityKey.length); if(da !== db) return da - db;
      return a[0].length - b[0].length;
    }); return candidates[0];
  }

  async function fetchCensusForCity(city){
    const st = String(city?.state ?? "").toUpperCase(); const stateFips = STATE_FIPS[st]; if(!stateFips) throw new Error(`No state FIPS`);
    const entries = await ensurePlaceIndex(stateFips); const match = pickBestPlace(entries, city.city); if(!match) throw new Error(`Place not found`);
    const placeFips = match[1]; const cacheKey = censusCityKey(stateFips, placeFips);
    const cached = readLS(cacheKey); if(cached && cached.ts && (Date.now() - cached.ts) < CENSUS_CITY_TTL_MS && cached.data){ return cached.data; }
    const url = `${CENSUS_BASE}?get=NAME,DP02_0068PE,DP03_0062E&for=place:${placeFips}&in=state:${stateFips}`;
    const rows = await fetchJsonWithTimeout(url, 15000); const r = rows?.[1]; if(!r) throw new Error(`Unexpected Census response`);
    const data = { name: r[0], bachelorsPct: (r[1] !== null && r[1] !== undefined && r[1] !== "") ? Number(r[1]) : null, medianIncome: (r[2] !== null && r[2] !== undefined && r[2] !== "") ? Number(r[2]) : null, acsYear: ACS_YEAR };
    writeLS(cacheKey, {ts: Date.now(), data}); return data;
  }

  async function ensureCensus(city){
    if(!city) return; if(city._census || city._censusLoading || city._censusError) return; city._censusLoading = true;
    try { city._census = await fetchCensusForCity(city); city._censusError = false; } catch (e) { city._census = null; city._censusError = true; } 
    finally { city._censusLoading = false; if(pinned && pinned.size > 0) renderPinnedPanel(); refreshTooltipIfHovering(city); }
  }

  function showTooltip(event, d) {
    setHoverState(d, event);
    ensureCensus(d);
    ensureAQI(d);

    const wx = d._wx;
    const pop = (d.pop != null) ? d.pop.toLocaleString('en-US') : "—";
    const mem = memoryForCityKey(cityKey(d));
    const memoryHTML = mem ? `<div class="divider"></div><div class="secTitle">Memory</div><div class="tooltip-memory">${escapeHTML(mem.memory_date)} - ${escapeHTML(mem.note || "")}</div>` : "";
    const movieTitle = String(d?.movie || "").trim();
    const movieYear = Number.isFinite(Number(d?.movieYear)) ? Number(d.movieYear) : null;
    const horrorHeroHTML = (isSpookyMode && movieTitle)
      ? `<div class="tooltip-horror-hero"><div class="tooltip-horror-label">Featured Horror</div><div class="tooltip-horror-movie">${escapeHTML(movieTitle)}${movieYear ? ` <span class="muted">(${movieYear})</span>` : ""}</div></div>`
      : "";
    const sportsHTML = sportsBlockHTML(cityKey(d));
    const headerHTML = `<div class="tooltip-head"><div class="tooltip-city"><strong>${d.city}, ${d.state}</strong></div></div>`;
    const coldestDay = d?._coldest5y || wx?.coldestDay || null;
    const coldestSource = d?._coldest5y ? "5y" : "loaded";
    const coldestDateTxt = formatDateLong(coldestDay?.date);
    const coldestLowTxt = (coldestDay?.low != null && isFinite(coldestDay.low)) ? `${Math.round(coldestDay.low)}°F` : "—";
    const coldestSourceLabel = coldestSource === "5y" ? "last 5 years" : "loaded data window";
    const coldestInfoHTML = (colorMode === "coldest")
      ? `<div class="divider"></div><div class="secTitle">Coldest day in ${coldestSourceLabel}</div><div class="tooltip-memory">${coldestDateTxt} • Low ${coldestLowTxt}</div>`
      : "";

    const cen = d._census; const cenLoading = !!d._censusLoading; const cenErr = !!d._censusError;
    const baTxt = (cen && cen.bachelorsPct != null && isFinite(cen.bachelorsPct)) ? fmtPct1(cen.bachelorsPct) : (cenLoading ? "…" : "—");
    const incTxt = (cen && cen.medianIncome != null && isFinite(cen.medianIncome)) ? fmtUSDCompact(cen.medianIncome) : (cenLoading ? "…" : "—");
    const incTitle = (cen && cen.medianIncome != null && isFinite(cen.medianIncome)) ? fmtUSD(cen.medianIncome) : "";
    const profileNote = cenErr ? `<div class="muted" style="margin-top:4px;">City profile unavailable.</div>` : "";

    const cityProfileHTML = `
      <div class="divider"></div>
      <div class="secTitle">City profile <span class="infoIcon" title="${CENSUS_SOURCE_TITLE}">ⓘ</span></div>
      <div class="statGrid">
        <div class="statTile">
          <div class="statLabel">Population</div>
          <div class="statValue ${pop === "—" ? "mutedVal" : ""}">${pop}</div>
        </div>
        <div class="statTile">
          <div class="statLabel">Bachelor’s+ (25+)</div>
          <div class="statValue ${baTxt === "—" || baTxt === "…" ? "mutedVal" : ""}">${baTxt}</div>
        </div>
        <div class="statTile">
          <div class="statLabel">Median household income</div>
          <div class="statValue ${incTxt === "—" || incTxt === "…" ? "mutedVal" : ""}" ${incTitle ? `title="${incTitle}"` : ""}>${incTxt}</div>
        </div>
      </div>
      ${profileNote}
    `;

    let aqiChip = "";
    if (d._aqi) {
      const stat = getAQIStatus(d._aqi.aqi);
      aqiChip = `<span class="chip" style="border-color:${stat.color};">AQI ${d._aqi.aqi} (${stat.label})</span>`;
    } else if (d._aqiLoading) {
      aqiChip = `<span class="chip" style="opacity:0.7;">Loading AQI...</span>`;
    }

    if (wx === undefined) {
      tooltipEl.style.display = "block";
      tooltipEl.innerHTML = `${headerHTML}${horrorHeroHTML}<div class="divider"></div><div class="tooltip-empty">Loading forecast…</div>${aqiChip ? `<div class="chipRow">${aqiChip}</div>` : ""}${coldestInfoHTML}${sportsHTML}${memoryHTML}${cityProfileHTML}`;
      tooltipEl.classList.remove("tooltip-enter");
      void tooltipEl.offsetWidth;
      tooltipEl.classList.add("tooltip-enter");
      moveTooltip(event); return;
    }

    if (d._wxError || !wx) {
      tooltipEl.style.display = "block";
      tooltipEl.innerHTML = `${headerHTML}${horrorHeroHTML}<div class="divider"></div><div class="tooltip-empty">${weatherBadgeHTML(d)} <span style="margin-left:6px;">Weather unavailable.</span></div>${aqiChip ? `<div class="chipRow">${aqiChip}</div>` : ""}${coldestInfoHTML}${sportsHTML}${memoryHTML}${cityProfileHTML}`;
      tooltipEl.classList.remove("tooltip-enter");
      void tooltipEl.offsetWidth;
      tooltipEl.classList.add("tooltip-enter");
      moveTooltip(event); return;
    }

    const cur = wx.current ?? {};
    const cond = wxCodeToIconLabel(cur.code);
    const temp = fmtInt(cur.temp); const feels = fmtInt(cur.feels);
    const hum = fmtInt(cur.humidity); const cloud = fmtInt(cur.cloud);
    const ws = fmtInt(cur.windSpeed); const wg = fmtInt(cur.windGust);
    const wdir = degToCompass(cur.windDir); const wdeg = (cur.windDir != null && isFinite(cur.windDir)) ? ` (${Math.round(cur.windDir)}°)` : "";

    const forecastCards = format3DayTooltipCards(d);
    const spark = sparklineBlockForCity(d);
    const upsideBadge = isUpsideDownMode ? `<span class="chip badge upside">Upside Down Signal</span>` : "";
    const riftBadge = (isUpsideDownMode && d?._inRift)
      ? `<span class="chip badge rift">Rift Interference</span>`
      : "";
    const showColdestMode = colorMode === "coldest";
    const heroMain = showColdestMode ? coldestLowTxt : `${temp}°F`;
    const heroSummary = showColdestMode
      ? `Coldest day: ${coldestDateTxt} <span class="muted">(best available from ${coldestSourceLabel})</span>`
      : `${cond.icon} ${cond.label} <span class="muted">(feels ${feels}°F)</span>`;
    const currentSnapshotHTML = showColdestMode
      ? `<div class="tooltip-current-note">Current: ${temp}°F ${cond.icon} ${cond.label}</div>`
      : "";

    tooltipEl.style.display = "block";
    tooltipEl.innerHTML = `
      ${headerHTML}
      ${horrorHeroHTML}
      <div class="divider"></div>
      <div class="tooltip-hero">
        <div class="tooltip-temp">${heroMain}</div>
        <div class="tooltip-summary">${heroSummary}</div>
        <div class="tooltip-status">${weatherBadgeHTML(d)} ${upsideBadge} ${riftBadge}</div>
      </div>
      ${currentSnapshotHTML}
      ${coldestInfoHTML}
      <div class="chipRow">
        <span class="chip metric-chip"><span>💧 Hum</span><strong>${hum}%</strong></span>
        <span class="chip metric-chip"><span>☁️ Clouds</span><strong>${cloud}%</strong></span>
        <span class="chip metric-chip"><span>🌬️ Wind</span><strong>${ws} mph ${wdir}${wdeg}</strong></span>
        <span class="chip metric-chip"><span>💨 Gust</span><strong>${wg} mph</strong></span>
        ${aqiChip}
      </div>
      ${spark}
      <div class="divider"></div>
      <div class="secTitle">3‑day forecast <span class="muted" style="font-weight:700;">(high/low + precip)</span></div>
      <div style="margin-top:6px;">${forecastCards}</div>
      ${sportsHTML}
      ${memoryHTML}
      ${cityProfileHTML}
    `;
    tooltipEl.classList.remove("tooltip-enter");
    void tooltipEl.offsetWidth;
    tooltipEl.classList.add("tooltip-enter");
    moveTooltip(event);
  }

  function moveTooltip(event) {
    if(event && event.clientX != null && event.clientY != null){ _lastTooltipPt = {clientX: event.clientX, clientY: event.clientY}; }
    const bounds = document.getElementById("map").getBoundingClientRect();
    const pad = 12;
    const tipW = tooltipEl.offsetWidth || 320;
    const tipH = tooltipEl.offsetHeight || 260;
    let x = (event.clientX - bounds.left) + 14;
    let y = (event.clientY - bounds.top) - tipH - 10;
    if (x + tipW > bounds.width - pad) x = bounds.width - tipW - pad;
    if (x < pad) x = pad;
    if (y < pad) y = (event.clientY - bounds.top) + 16;
    if (y + tipH > bounds.height - pad) y = bounds.height - tipH - pad;
    if (y < pad) y = pad;
    tooltipEl.style.left = `${x}px`; tooltipEl.style.top = `${y}px`;
  }

  function hideTooltip() { clearHoverState(); tooltipEl.style.display = "none"; }

  function updateDayLabelUI(){
    if(colorMode === "aqi"){
       if(dayLabelEl) dayLabelEl.textContent = "Live AQI";
       if(legendTagEl) legendTagEl.textContent = "Current Conditions";
       return;
    }
    if(colorMode === "coldest"){
      if(dayLabelEl) dayLabelEl.textContent = "Coldest";
      if(legendTagEl) legendTagEl.textContent = "Coldest Day (Loaded Window)";
      return;
    }
    const sampleCity = activeCities.find(c => c._wx && c._wx.hourly && c._wx.hourly.time && c._wx.hourly.time.length > selectedHourIndex);
    if(sampleCity) {
      const dt = new Date(sampleCity._wx.hourly.time[selectedHourIndex]);
      const formatted = dt.toLocaleTimeString([], { weekday: 'short', hour: 'numeric' });
      if(dayLabelEl) dayLabelEl.textContent = formatted;
      if(legendTagEl) legendTagEl.textContent = `${formatted} ${colorMode === 'precip' ? 'Precip' : 'Temp'}`;
    } else {
      if(dayLabelEl) dayLabelEl.textContent = `+${selectedHourIndex}h`;
    }
  }

  const PINNED_KEY = "uswx:pins:top25";
  const pinned = new Map();

  function cityKey(d){ return `${d.city},${d.state}`; }

  function loadPinned(){ try { const raw = localStorage.getItem(PINNED_KEY); if(!raw) return; const arr = JSON.parse(raw); if(!Array.isArray(arr)) return; for(const k of arr){ const c = activeCities.find(x => cityKey(x) === k); if(c) pinned.set(k, c); } } catch {} }
  function savePinned(){ try { localStorage.setItem(PINNED_KEY, JSON.stringify(Array.from(pinned.keys()))); } catch {} }
  function formatDOW(dateStr){ if(!dateStr) return "—"; const dt = new Date(`${dateStr}T12:00:00`); return dt.toLocaleDateString(undefined, { weekday: "short" }); }
  function formatDateLong(dateStr){ if(!dateStr) return "—"; const dt = new Date(`${dateStr}T12:00:00`); return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }); }
  function isPinningDisabledMode(){ return colorMode === "coldest"; }
  function isTouchContext(event){
    if(event && typeof event.pointerType === "string") return event.pointerType === "touch";
    if(event && event.sourceEvent && typeof event.sourceEvent.pointerType === "string") return event.sourceEvent.pointerType === "touch";
    try { return window.matchMedia && window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
  }
  function updateModeUXHints(){
    const coldest = colorMode === "coldest";
    if(modeInfoChip) modeInfoChip.hidden = !coldest;
    if(modeSubnote){
      modeSubnote.hidden = !coldest;
      if(coldest){
        const base = "Map color uses each city's coldest low from last 5 years.";
        const suffix = coldestMeta.computing ? " Updating in background…" : (coldestMeta.stale ? " Cached values may be stale." : "");
        modeSubnote.textContent = `${base}${suffix}`;
      }
    }
    if(pinnedHintEl){
      pinnedHintEl.textContent = coldest ? "Pins disabled in Coldest Mode" : "Click dots to pin";
      pinnedHintEl.style.color = coldest ? "#fca5a5" : "";
    }
  }

  function format3DayStrip(city){
    const wx = city?._wx;
    const parts = [0,1,2].map(i => {
      const ds = wx?.dates?.[i] ?? null; const hi = wx?.hi?.[i]; const lo = wx?.lo?.[i]; const pr = wx?.precip?.[i];
      const h = (hi != null && isFinite(hi)) ? Math.round(hi) : "—"; const l = (lo != null && isFinite(lo)) ? Math.round(lo) : "—";
      const p = (pr != null && isFinite(pr)) ? ` · 💧${Math.round(pr)}%` : "";
      const txt = `${formatDOW(ds)}: H ${h}° / L ${l}°${p}`;
      const currentDayIdx = Math.floor(selectedHourIndex / 24);
      return (i === currentDayIdx) ? `<span class="sel">${txt}</span>` : txt;
    });
    return parts.join("  |  ");
  }

  function format3DayPills(city){
    const wx = city?._wx;
    const currentDayIdx = Math.floor(selectedHourIndex / 24);
    const cards = [0,1,2].map(i => {
      const ds = wx?.dates?.[i] ?? null;
      const hi = wx?.hi?.[i];
      const lo = wx?.lo?.[i];
      const pr = wx?.precip?.[i];
      const h = (hi != null && isFinite(hi)) ? `${Math.round(hi)}°` : "—";
      const l = (lo != null && isFinite(lo)) ? `${Math.round(lo)}°` : "—";
      const p = (pr != null && isFinite(pr)) ? `${Math.round(pr)}%` : "—";
      return `<div class="pin-forecast-card ${i === currentDayIdx ? "is-current" : ""}"><div class="pin-forecast-day">${formatDOW(ds)}</div><div class="pin-forecast-temp">${h} / ${l}</div><div class="pin-forecast-precip">💧 ${p}</div></div>`;
    }).join("");
    return `<div class="pin-forecast-grid">${cards}</div>`;
  }

  function format3DayTooltipCards(city){
    const wx = city?._wx;
    const currentDayIdx = Math.floor(selectedHourIndex / 24);
    const cards = [0,1,2].map(i => {
      const ds = wx?.dates?.[i] ?? null;
      const hi = wx?.hi?.[i];
      const lo = wx?.lo?.[i];
      const pr = wx?.precip?.[i];
      const h = (hi != null && isFinite(hi)) ? `${Math.round(hi)}°` : "—";
      const l = (lo != null && isFinite(lo)) ? `${Math.round(lo)}°` : "—";
      const p = (pr != null && isFinite(pr)) ? `${Math.round(pr)}%` : "—";
      return `<div class="tooltip-forecast-card ${i === currentDayIdx ? "is-current" : ""}"><div class="tooltip-forecast-day">${formatDOW(ds)}</div><div class="tooltip-forecast-temp">${h} / ${l}</div><div class="tooltip-forecast-precip">💧 ${p}</div></div>`;
    }).join("");
    return `<div class="tooltip-forecast-grid">${cards}</div>`;
  }

  function animateHoverRing(city){
    try {
      const sel = d3.selectAll("g.city").filter(d => cityKey(d) === cityKey(city));
      const ring = sel.select("circle.hover-ring"); const dot  = sel.select("circle.city-dot");
      if (ring.empty() || dot.empty()) return;
      const base = parseFloat(dot.attr("r")) || 4.85;
      ring.interrupt("ring").attr("r", base * 1.15).style("opacity", 0.65).transition("ring").duration(1000).ease(d3.easeCubicOut).attr("r", base * 3.2).style("opacity", 0);
    } catch(e) {}
  }

  function pulseDotOnce(city){
    try {
      const sel = d3.selectAll("g.city").filter(d => cityKey(d) === cityKey(city));
      const dot = sel.select("circle.city-dot"); if(dot.empty()) return;
      const base = parseFloat(dot.attr("r")) || 4.85;
      dot.interrupt("pulse").transition("pulse").duration(140).attr("r", base * 1.22).transition("pulse").duration(260).attr("r", base);
    } catch(e) {}
  }

  function getNext24Temps(wx){
    const times = wx?.hourly?.time ?? []; const temps = wx?.hourly?.temp ?? []; if(!times.length || !temps.length) return null;
    let idx = 0; const ct = wx?.current?.time;
    if(ct && typeof ct === "string"){
      idx = times.indexOf(ct);
      if(idx < 0 && ct.length >= 13){
        const hourT = ct.slice(0,13) + ":00"; idx = times.indexOf(hourT);
        if(idx < 0) idx = times.findIndex(t => t >= hourT);
      }
      if(idx < 0) idx = 0;
    }
    const slice = temps.slice(idx, idx + 24).filter(v => v != null && isFinite(v));
    if(slice.length < 2) return null; return slice;
  }

  function sparklineSVG(temps){
    const W = 230, H = 46, P = 4; const n = temps.length;
    let min = Infinity, max = -Infinity; for (const t of temps){ if(t < min) min = t; if(t > max) max = t; }
    if(!isFinite(min) || !isFinite(max)) return ""; const span = (max - min) || 1;
    const x = (i) => P + (i * (W - 2*P) / (n - 1)); const y = (t) => P + ((max - t) * (H - 2*P) / span);
    let d = ""; for(let i=0;i<n;i++){ const xi = x(i), yi = y(temps[i]); d += (i===0 ? "M" : "L") + xi.toFixed(2) + "," + yi.toFixed(2); }
    const yBase = (H - P); const dArea = d + `L${x(n-1).toFixed(2)},${yBase.toFixed(2)}L${x(0).toFixed(2)},${yBase.toFixed(2)}Z`;
    const endX = x(n-1).toFixed(2); const endY = y(temps[n-1]).toFixed(2);
    return `<div class="sparkWrap"><div class="sparkHead"><div class="sparkTitle">Next 24h temp</div><div class="sparkMinMax">${Math.round(min)}°–${Math.round(max)}°</div></div><div class="sparkBox"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Next 24 hours temperature sparkline"><path class="sparkArea" d="${dArea}"></path><path class="sparkLine" d="${d}"></path><circle class="sparkEnd" cx="${endX}" cy="${endY}" r="2.6"></circle></svg></div></div>`;
  }

  function sparklineBlockForCity(city){ const wx = city?._wx; const temps = getNext24Temps(wx); if(!temps) return ""; return sparklineSVG(temps); }

  function renderPinnedPanel(){
    if(!pinnedPanelEl || !pinnedListEl) return;
    if(isPinningDisabledMode()){
      pinnedPanelEl.style.display = "none";
      pinnedListEl.innerHTML = "";
      return;
    }
    const keys = Array.from(pinned.keys());
    if(keys.length === 0){ pinnedPanelEl.style.display = "none"; pinnedListEl.innerHTML = ""; return; }
    pinnedPanelEl.style.display = "block";

    const rows = keys.slice().reverse().map(k => {
      const c = pinned.get(k); const pop = (c?.pop != null) ? c.pop.toLocaleString("en-US") : "—";
      const mem = memoryForCityKey(cityKey(c));
      const memoryLine = mem ? `<div class="pin-memory">Memory (${escapeHTML(mem.memory_date)}): ${escapeHTML(mem.note || "")}</div>` : "";
      const sportsHTML = (() => {
        const games = gamesForCityKey(cityKey(c));
        if(!isSportsFilterActive || games.length === 0) return "";
        const byLeague = new Map();
        for(const g of games){
          const key = String(g.league || "Other");
          if(!byLeague.has(key)) byLeague.set(key, []);
          byLeague.get(key).push(g);
        }
        const groups = Array.from(byLeague.entries()).map(([league, list]) => {
          const rows = list.map((g) => `<div class="pin-sports-row"><span class="pin-sports-match">${g.emoji} ${escapeHTML(g.away)} @ ${escapeHTML(g.home)}</span><span class="pin-sports-time">${escapeHTML(g.timeET)} ET</span></div>`).join("");
          return `<div class="pin-sports-group"><div class="pin-sports-league">${escapeHTML(league)}</div>${rows}</div>`;
        }).join("");
        return `<div class="pin-tile pin-sports-tile"><div class="pin-tile-title">Game Day</div><div class="pin-sports-list">${groups}</div></div>`;
      })();
      ensureCensus(c); ensureAQI(c);

      let heroMain = `—`;
      let heroSub = `<span style="color: var(--muted);">Loading current conditions…</span>`;
      let conditionsRows = `<div class="pin-data-row"><span class="pin-data-label">Status</span><span class="pin-data-value">Loading…</span></div>`;
      let forecastHTML = `<div class="pinStrip"><span style="color: var(--muted);">Loading forecast…</span></div>`;

      if (c?._wxError) {
        heroSub = `${weatherBadgeHTML(c)} <span style="color: var(--muted); margin-left:6px;">Weather unavailable.</span>`;
      } else if (c?._wx) {
        const wx = c._wx; const cur = wx.current ?? {}; const cond = wxCodeToIconLabel(cur.code);
        const temp = fmtInt(cur.temp); const feels = fmtInt(cur.feels); const hum = fmtInt(cur.humidity); const cloud = fmtInt(cur.cloud);
        const ws = fmtInt(cur.windSpeed); const wg = fmtInt(cur.windGust); const wdir = degToCompass(cur.windDir);
        heroMain = `${temp}°F`;
        heroSub = `${cond.icon} ${cond.label} <span style="color: var(--muted);">feels ${feels}°F</span>`;
        conditionsRows = `<div class="pin-data-row"><span class="pin-data-label">Humidity</span><span class="pin-data-value">${hum}%</span></div><div class="pin-data-row"><span class="pin-data-label">Wind</span><span class="pin-data-value">${ws} mph ${wdir}</span></div><div class="pin-data-row"><span class="pin-data-label">Gust</span><span class="pin-data-value">${wg} mph</span></div><div class="pin-data-row"><span class="pin-data-label">Clouds</span><span class="pin-data-value">${cloud}%</span></div>`;
        forecastHTML = format3DayPills(c);
      }

      let aqiLine = `<div class="pin-data-row"><span class="pin-data-label">AQI</span><span class="pin-data-value">—</span></div>`;
      if (c._aqi) {
        const stat = getAQIStatus(c._aqi.aqi);
        aqiLine = `<div class="pin-data-row"><span class="pin-data-label">AQI</span><span class="pin-data-value"><strong style="color:${stat.color}">${c._aqi.aqi}</strong> <span class="pin-value-note">(${stat.label})</span></span></div>`;
      }

      const cen = c?._census; const cenLoading = !!c?._censusLoading; const cenErr = !!c?._censusError;
      const baTxt = (cen && cen.bachelorsPct != null && isFinite(cen.bachelorsPct)) ? fmtPct1(cen.bachelorsPct) : (cenLoading ? "…" : "—");
      const incTxt = (cen && cen.medianIncome != null && isFinite(cen.medianIncome)) ? fmtUSDCompact(cen.medianIncome) : (cenLoading ? "…" : "—");
      const incTitle = (cen && cen.medianIncome != null && isFinite(cen.medianIncome)) ? fmtUSD(cen.medianIncome) : "";
      const profileNote = cenErr ? `<div class="pinMeta" style="margin-top:4px;">City profile unavailable.</div>` : "";
      const wxMeta = c?._wxMeta || {};
      const statusChips = [];
      if(isUpsideDownMode) statusChips.push(`<span class="pin-chip pin-chip-upside">Upside Down Signal</span>`);
      if(isUpsideDownMode && c?._inRift) statusChips.push(`<span class="pin-chip pin-chip-rift">Rift Zone</span>`);
      if(isHistoricalMode) statusChips.push(`<span class="pin-chip">Time Machine</span>`);
      if(wxMeta.source === "live") statusChips.push(`<span class="pin-chip pin-chip-live">Live</span>`);
      if(wxMeta.source === "cache") statusChips.push(`<span class="pin-chip pin-chip-cache">Cached</span>`);
      if(c?._aqi?.aqi != null && isFinite(c._aqi.aqi) && !isHistoricalMode){
        const stat = getAQIStatus(c._aqi.aqi);
        statusChips.push(`<span class="pin-chip" style="border-color:${stat.color}; color:${stat.color};">AQI ${c._aqi.aqi}</span>`);
      }
      const chipRow = statusChips.length ? `<div class="pin-chip-row">${statusChips.join("")}</div>` : "";

      const profileHTML = `<div class="pin-data-row"><span class="pin-data-label">Population</span><span class="pin-data-value">${pop}</span></div><div class="pin-data-row"><span class="pin-data-label">Bachelor's+ (25+)</span><span class="pin-data-value">${baTxt}</span></div><div class="pin-data-row"><span class="pin-data-label">Median income</span><span class="pin-data-value" ${incTitle ? `title="${incTitle}"` : ""}>${incTxt}</span></div><div class="pin-tile-foot">Source: US Census <span class="infoIcon" title="${CENSUS_SOURCE_TITLE}">ⓘ</span></div>${profileNote}`;

      return `<div class="pinRow"><button class="pinRemove" data-key="${k}" title="Remove">✕</button><div class="pinMain"><div class="pin-head"><div class="pinCity"><strong>${c.city}, ${c.state}</strong></div>${chipRow}</div><div class="pinHero"><div class="pinHeroMain">${heroMain}</div><div class="pinHeroSub">${heroSub}</div></div>${memoryLine}<div class="pin-bento-grid"><div class="pin-tile"><div class="pin-tile-title">Conditions</div>${aqiLine}${conditionsRows}</div><div class="pin-tile"><div class="pin-tile-title">City Profile</div>${profileHTML}</div></div><div class="pinForecastBlock"><div class="pinForecastTitle">3-day forecast</div>${forecastHTML}</div>${sportsHTML}</div></div>`;
    }).join("");

    pinnedListEl.innerHTML = rows;
  }

  function updatePinnedStyles(){
    const isPinned = d => !isPinningDisabledMode() && pinned.has(cityKey(d));
    const disablePins = isPinningDisabledMode();
    gCities.selectAll("g.city").classed("pin-disabled", disablePins);
    gCities.selectAll("g.city").classed("pinned", isPinned);
    gCities.selectAll("g.city circle.city-dot").attr("r", d => isPinned(d) ? 6.3 : 4.85).style("stroke-width", d => isPinned(d) ? 2.2 : 0.8).style("stroke", d => isPinned(d) ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.35)");
    updateClusterLayout(lastZoomTransform?.k || 1);
  }

  function buildCityClusters(zoomK = 1) {
    const radiusPx = Number(CLUSTER_CONFIG.radiusPx) || 28;
    const radiusWorld = radiusPx / Math.max(1, Number(zoomK) || 1);
    const cityToCluster = new Map();
    const visibleCities = activeCities.filter((d) => {
      const key = cityKey(d);
      return Array.isArray(d?._xy) && !pinned.has(key);
    });
    const qt = d3.quadtree()
      .x((d) => d._xy[0])
      .y((d) => d._xy[1])
      .addAll(visibleCities);

    const visited = new Set();
    const clusters = [];

    for (const seed of visibleCities) {
      const seedKey = cityKey(seed);
      if (visited.has(seedKey)) continue;
      const queue = [seed];
      const members = [];
      visited.add(seedKey);

      while (queue.length) {
        const current = queue.pop();
        members.push(current);
        const [cx, cy] = current._xy;
        qt.visit((node, x0, y0, x1, y1) => {
          if (x0 > cx + radiusWorld || x1 < cx - radiusWorld || y0 > cy + radiusWorld || y1 < cy - radiusWorld) return true;
          if (!node.length) {
            let q = node;
            while (q) {
              const candidate = q.data;
              const candidateKey = cityKey(candidate);
              if (!visited.has(candidateKey)) {
                const dx = candidate._xy[0] - cx;
                const dy = candidate._xy[1] - cy;
                if ((dx * dx) + (dy * dy) <= radiusWorld * radiusWorld) {
                  visited.add(candidateKey);
                  queue.push(candidate);
                }
              }
              q = q.next;
            }
          }
          return false;
        });
      }

      if (members.length >= (Number(CLUSTER_CONFIG.minPoints) || 2)) {
        const totalPop = members.reduce((sum, c) => sum + Math.max(1, Number(c.pop) || 1), 0);
        const cx = members.reduce((sum, c) => sum + (c._xy[0] * Math.max(1, Number(c.pop) || 1)), 0) / totalPop;
        const cy = members.reduce((sum, c) => sum + (c._xy[1] * Math.max(1, Number(c.pop) || 1)), 0) / totalPop;
        const representative = members.reduce((best, c) => (Number(c.pop) > Number(best.pop) ? c : best), members[0]);
        const keys = members.map((c) => cityKey(c)).sort();
        const id = `cluster:${keys.join("|")}`;
        const cluster = { id, members, count: members.length, cx, cy, representative };
        clusters.push(cluster);
        for (const m of members) cityToCluster.set(cityKey(m), cluster);
      }
    }

    return { clusters, cityToCluster };
  }

  function updateClusterLayout(zoomK = 1) {
    if (!gCities || !gClusters) return;
    clusterState.zoomK = zoomK;
    const built = buildCityClusters(zoomK);
    clusterState.clusters = built.clusters;
    clusterState.cityToCluster = built.cityToCluster;

    const clusterSel = gClusters.selectAll("g.cluster")
      .data(clusterState.clusters, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "cluster");
          g.append("circle").attr("class", "cluster-hit").attr("r", 18);
          g.append("circle").attr("class", "cluster-dot").attr("r", CLUSTER_DOT_RADIUS);
          appendWeatherIconGlyph(g, "cluster-weather-icon").attr("transform", "translate(-2,-7) scale(0.9)");
          g.append("text").attr("class", "cluster-count").attr("dy", 4).attr("text-anchor", "middle");
          g.on("click", (event, d) => {
            event.stopPropagation();
            if (!zoom) return;
            const width = mapWidth || 960;
            const height = mapHeight || 600;
            const nextK = Math.min(8, Math.max((lastZoomTransform?.k || 1) * 1.8, 2));
            const t = d3.zoomIdentity.translate((width / 2) - (d.cx * nextK), (height / 2) - (d.cy * nextK)).scale(nextK);
            svg.transition().duration(280).call(zoom.transform, t);
          });
          return g;
        },
        (update) => update,
        (exit) => exit.remove()
      );

    clusterSel.attr("transform", (d) => `translate(${d.cx},${d.cy})`);
    clusterSel.select("text.cluster-count").text((d) => d.count);
    updateWeatherIconsForSelection(clusterSel, (d) => d.representative);

    gCities.selectAll("g.city")
      .classed("is-clustered", (d) => clusterState.cityToCluster.has(cityKey(d)))
      .style("display", (d) => clusterState.cityToCluster.has(cityKey(d)) ? "none" : null);

    if (_hoverCityKey && clusterState.cityToCluster.has(_hoverCityKey)) hideTooltip();
  }

  function togglePin(d){
    if(isPinningDisabledMode()){
      setStatus("Pin cards are disabled for Coldest Day mode (hover only).");
      return;
    }
    const k = cityKey(d); focusedKey = k;
    if(pinned.has(k)) pinned.delete(k);
    else { pinned.delete(k); pinned.set(k, d); ensureCensus(d); ensureAQI(d); }
    savePinned(); renderPinnedPanel(); updatePinnedStyles(); applyFocusStyles(); schedulePermalinkUpdate();
  }

  function debounce(fn, ms = 120) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

  async function asyncPool(limit, items, iteratorFn) {
    const ret = []; const executing = [];
    for (const item of items) {
      const p = Promise.resolve().then(() => iteratorFn(item)); ret.push(p);
      if (limit <= items.length) {
        const e = p.then(() => executing.splice(executing.indexOf(e), 1)); executing.push(e);
        if (executing.length >= limit) { await Promise.race(executing); }
      }
    }
    return Promise.allSettled(ret);
  }

  let colorScale = null; let lastMinHigh = null; let lastMaxHigh = null;

  function getSelectedMetric(d){
    if(colorMode === "aqi") return d?._aqi?.aqi;
    if(colorMode === "coldest"){
      const v = d?._coldest5y?.low ?? d?._wx?.coldestDay?.low;
      return (typeof v === "number" && isFinite(v)) ? v : null;
    }
    if(colorMode === "precip") {
      const v = d?._wx?.hourly?.precip?.[selectedHourIndex]; return (typeof v === "number" && isFinite(v)) ? v : null;
    }
    const v = d?._wx?.hourly?.temp?.[selectedHourIndex]; return (typeof v === "number" && isFinite(v)) ? v : null;
  }

  function updateSurfaceOverlay(animated){
    if(!surfaceEnabled){ gSurface.style("display","none"); return; }
    if(!mapWidth || !mapHeight || !colorScale){ gSurface.style("display","none"); return; }
    const pts = [];
    for(const c of activeCities){
      const v = getSelectedMetric(c); if(v == null || !c._xy) continue; pts.push({x: c._xy[0], y: c._xy[1], v});
    }
    if(pts.length < 3){ gSurface.style("display","none"); return; }
    gSurface.style("display", null);

    const cell = SURFACE_CELL_PX; const gw = Math.max(30, Math.round(mapWidth / cell)); const gh = Math.max(20, Math.round(mapHeight / cell));
    const power = 2; const eps = 1e-6; const maxR = 520; 
    const values = new Array(gw * gh);

    for(let j=0; j<gh; j++){
      const y = j * cell;
      for(let i=0; i<gw; i++){
        const x = i * cell; let num = 0, den = 0;
        for(const p of pts){
          const dx = x - p.x, dy = y - p.y; const d2 = dx*dx + dy*dy; if(d2 > maxR*maxR) continue;
          const w = 1 / (Math.pow(d2 + eps, power/2)); num += w * p.v; den += w;
        }
        values[j*gw + i] = (den > 0) ? (num/den) : NaN;
      }
    }

    const domain = colorMode === "aqi" ? [0, 300] : colorScale.domain();
    const thresholds = colorMode === "aqi" ? [0, 50, 100, 150, 200, 300] : d3.ticks(domain[0], domain[1], 14);
    const contours = d3.contours().size([gw, gh]).thresholds(thresholds)(values);
    const contourPath = d3.geoPath(d3.geoIdentity().scale(cell));
    const sel = gSurface.selectAll("path.contour").data(contours, d => d.value);

    sel.join(
      enter => enter.append("path").attr("class", "contour").attr("d", contourPath).attr("fill", d => colorScale(d.value)).attr("opacity", 0.0).call(enter => enter.transition().duration(animated ? 320 : 0).attr("opacity", 0.38)),
      update => update.call(update => { if(animated){ update.transition().duration(320).attr("d", contourPath).attr("fill", d => colorScale(d.value)); }else{ update.attr("d", contourPath).attr("fill", d => colorScale(d.value)); } }),
      exit => exit.call(exit => exit.transition().duration(200).attr("opacity", 0).remove())
    );
  }

  function applyDotColors(animated = true) {
    const circles = gCities.selectAll("g.city circle.city-dot");
    const fillFor = (d) => {
      const v = getSelectedMetric(d);
      if (colorScale && v != null) return colorScale(v);
      return ERROR_COLOR;
    };
    circles.style("fill", fillFor);
    gClusters.selectAll("g.cluster circle.cluster-dot").style("fill", (d) => fillFor(d.representative));
    updateWeatherIconsForSelection(gCities.selectAll("g.city"), (d) => d);
    updateWeatherIconsForSelection(gClusters.selectAll("g.cluster"), (d) => d.representative);

    updateWeatherFX();
    updateSurfaceOverlay(!!animated);
  }

  function updateWeatherFX(){
    const isRainCode = (code) => [51,53,55,56,57,61,63,65,66,67,80,81,82].includes(Number(code));
    const isSnowCode = (code) => [71,73,75,77,85,86].includes(Number(code));

    const citySel = gCities.selectAll("g.city");
    if(citySel.empty()) return;

    if(isUpsideDownMode){
      citySel.selectAll("line.wind-arrow").style("display", "none");
      citySel.selectAll("circle.particle-rain").style("display", "none");
      citySel.selectAll("circle.particle-snow").style("display", "none");
      citySel.selectAll("circle.particle-ash").style("display", null);
      citySel.selectAll("line.particle-filament").style("display", null);
      return;
    }

    citySel.each(function(d){
      const g = d3.select(this);
      const wx = d?._wx;
      const code = wx?.hourly?.code?.[selectedHourIndex];
      const ws = wx?.hourly?.windSpeed?.[selectedHourIndex];
      const showRain = code != null && isRainCode(code);
      const showSnow = code != null && isSnowCode(code);
      const showWind = ws != null && isFinite(ws) && Number(ws) >= 20;

      g.selectAll("circle.particle-ash").style("display", "none");
      g.selectAll("line.particle-filament").style("display", "none");
      g.selectAll("circle.particle-rain").style("display", showRain ? null : "none");
      g.selectAll("circle.particle-snow").style("display", showSnow ? null : "none");
      g.selectAll("line.wind-arrow").style("display", showWind ? null : "none");
    });
  }

  function updateLegend() {
    const legend = document.getElementById("legend");
    const bar = document.getElementById("legendBar");
    const minEl = document.getElementById("legendMin");
    const maxEl = document.getElementById("legendMax");
    if (!legend || !bar || !minEl || !maxEl) return;

    if (colorMode === "aqi") {
      bar.style.background = `linear-gradient(to right, #10b981 16%, #fbbf24 33%, #f97316 50%, #ef4444 66%, #a855f7 83%, #9f1239 100%)`;
      minEl.textContent = "0 (Good)";
      maxEl.textContent = "300+ (Hazardous)";
      legend.style.display = "flex";
      return;
    }

    if (!colorScale || lastMinHigh == null || lastMaxHigh == null || !isFinite(lastMinHigh) || !isFinite(lastMaxHigh)) {
      legend.style.display = "none";
      return;
    }

    const stops = 12; const parts = [];
    for (let i = 0; i <= stops; i++) { const t = i / stops; const v = lastMinHigh + (lastMaxHigh - lastMinHigh) * t; const c = colorScale(v); parts.push(`${c} ${(t * 100).toFixed(1)}%`); }
    bar.style.background = `linear-gradient(to right, ${parts.join(", ")})`;
    const unit = (colorMode === "precip") ? "%" : "°";
    minEl.textContent = `${Math.round(lastMinHigh)}${unit} (min)`;
    maxEl.textContent = `${Math.round(lastMaxHigh)}${unit} (max)`;
    legend.style.display = "flex";
  }

  function computeScaleFromLoaded(animated = true) {
    if (colorMode === "aqi") {
      colorScale = getAQIColor;
      applyDotColors(!!animated);
      updateLegend();
      return;
    }

    const vals = [];
    for (const c of activeCities) { const v = getSelectedMetric(c); if (typeof v === "number" && isFinite(v)) vals.push(v); }
    if (vals.length < 2) { applyDotColors(false); updateLegend(); return; }

    let vMin = d3.min(vals); let vMax = d3.max(vals);
    if (vMin === vMax) { vMin -= 1; vMax += 1; }
    lastMinHigh = vMin; lastMaxHigh = vMax;

    if (colorMode === "precip") {
      const d0 = Math.max(0, vMin); const d1 = Math.min(100, vMax); const pad = Math.max(2, (d1 - d0) * 0.06);
      const precipInterpolator = isUpsideDownMode ? d3.interpolateInferno : (isSpookyMode ? d3.interpolateReds : d3.interpolateBlues);
      colorScale = d3.scaleSequential().domain([d0 - pad, d1 + pad]).interpolator(precipInterpolator).clamp(true);
    } else {
      const pad = Math.max(1, (vMax - vMin) * 0.06);
      const tempInterpolator = isUpsideDownMode ? d3.interpolateInferno : (isSpookyMode ? d3.interpolateMagma : d3.interpolateTurbo);
      colorScale = d3.scaleSequential().domain([vMin - pad, vMax + pad]).interpolator(tempInterpolator).clamp(true);
    }

    applyDotColors(!!animated);
    updateLegend();
  }

  function initZoom(width, height) {
    zoom = d3.zoom().scaleExtent([1, 8]).translateExtent([[0, 0], [width, height]]).extent([[0, 0], [width, height]])
      .on("zoom", (event) => { lastZoomTransform = event.transform; gRoot.attr("transform", event.transform); updateClusterLayout(event.transform.k); })
      .on("end", () => { lastZoomTransform = d3.zoomTransform(svg.node()); schedulePermalinkUpdate(); });
    svg.call(zoom);
    applyPendingZoomIfAny();
    if(pendingFocusKey){ focusedKey = pendingFocusKey; pendingFocusKey = null; applyFocusStyles(); }
    if(!permalinkReady){ permalinkReady = true; suppressPermalink = false; updatePermalinkNow(); }
  }

  function resetView() { svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity); }

  function saveUserLocation(){
    try{
      if(!userLocation){ localStorage.removeItem(USER_LOCATION_KEY); return; }
      localStorage.setItem(USER_LOCATION_KEY, JSON.stringify(userLocation));
    } catch {}
  }

  function loadSavedUserLocation(){
    try{
      const raw = localStorage.getItem(USER_LOCATION_KEY);
      if(!raw) return;
      const parsed = JSON.parse(raw);
      const lat = Number(parsed?.lat);
      const lon = Number(parsed?.lon);
      const accuracy = Number(parsed?.accuracy);
      if(isFinite(lat) && isFinite(lon)) userLocation = { lat, lon, accuracy: isFinite(accuracy) ? accuracy : null };
    } catch {}
  }

  function zoomToUserLocation(){
    if(!userLocation || !projection || !zoom) return;
    const p = projection([userLocation.lon, userLocation.lat]);
    if(!p) return;
    const width = mapWidth || 960;
    const height = mapHeight || 600;
    const k = Math.max(3, (lastZoomTransform?.k || 1));
    const t = d3.zoomIdentity.translate((width / 2) - (p[0] * k), (height / 2) - (p[1] * k)).scale(k);
    svg.transition().duration(420).call(zoom.transform, t);
  }

  function updateUserLocationMarker(){
    if(!gUserLocation) return;
    if(!userLocation || !projection){
      gUserLocation.selectAll("#user-location-marker").remove();
      return;
    }
    const p = projection([userLocation.lon, userLocation.lat]);
    if(!p){
      gUserLocation.selectAll("#user-location-marker").remove();
      setStatus("Your location is outside the current US map view.");
      return;
    }

    const accuracyMeters = Number(userLocation.accuracy);
    const latForCalc = userLocation.lat;
    const lonForCalc = userLocation.lon;
    let accuracyPx = 0;
    if(isFinite(accuracyMeters) && accuracyMeters > 0){
      const cosLat = Math.cos((latForCalc * Math.PI) / 180);
      const metersPerDegLon = 111320 * Math.max(0.01, Math.abs(cosLat));
      const dLon = accuracyMeters / metersPerDegLon;
      const p2 = projection([lonForCalc + dLon, latForCalc]);
      if(p2){
        accuracyPx = Math.hypot(p2[0] - p[0], p2[1] - p[1]);
      }
    }
    const accuracyRadius = Math.max(12, Math.min(84, accuracyPx || 0));

    const marker = gUserLocation.selectAll("#user-location-marker")
      .data([userLocation])
      .join(enter => {
        const g = enter.append("g").attr("id", "user-location-marker").attr("tabindex", "0");
        g.append("circle").attr("class", "user-location-accuracy").attr("r", 0);
        g.append("circle")
          .attr("class", "user-location-ring")
          .attr("r", 7)
          .append("animate")
          .attr("attributeName", "r")
          .attr("values", "7;20;7;7")
          .attr("keyTimes", "0;0.22;0.42;1")
          .attr("dur", "3.2s")
          .attr("repeatCount", "indefinite");
        g.select("circle.user-location-ring")
          .append("animate")
          .attr("attributeName", "opacity")
          .attr("values", "0.72;0.18;0.18;0.72")
          .attr("keyTimes", "0;0.22;0.42;1")
          .attr("dur", "3.2s")
          .attr("repeatCount", "indefinite");
        g.append("circle").attr("class", "user-location-halo").attr("r", 10);
        g.append("circle").attr("class", "user-location-core").attr("r", 4.5);
        const tag = g.append("g").attr("class", "user-location-tag").attr("transform", "translate(-48,-33)");
        tag.append("rect").attr("rx", 8).attr("ry", 8).attr("width", 96).attr("height", 18);
        tag.append("text").attr("class", "user-location-label").attr("x", 48).attr("y", 12).text("Your location");
        return g;
      });

    marker.select("circle.user-location-accuracy")
      .style("display", accuracyRadius > 12 ? null : "none")
      .attr("r", accuracyRadius);
    marker.attr("transform", `translate(${p[0]},${p[1]})`);
    if(userLocationTagTimer){ clearTimeout(userLocationTagTimer); userLocationTagTimer = null; }
    marker.classed("is-recent", true);
    userLocationTagTimer = setTimeout(() => {
      gUserLocation.select("#user-location-marker").classed("is-recent", false);
      userLocationTagTimer = null;
    }, 3800);
    gUserLocation.raise();
  }

  function getCurrentPositionAsync(options){
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
  }

  async function locateUser(){
    if(!navigator.geolocation){
      alert("Unable to retrieve your location. Please check your browser permissions.");
      console.warn("Geolocation is not supported by this browser.");
      return;
    }
    try{
      const pos = await getCurrentPositionAsync({ enableHighAccuracy: true, timeout: 10000, maximumAge: 120000 });
      userLocation = { lat: Number(pos.coords.latitude), lon: Number(pos.coords.longitude), accuracy: Number(pos.coords.accuracy) };
      saveUserLocation();
      updateUserLocationMarker();
      zoomToUserLocation();
      setStatus(`Location found (${userLocation.lat.toFixed(3)}, ${userLocation.lon.toFixed(3)}).`);
    } catch (err){
      alert("Unable to retrieve your location. Please check your browser permissions.");
      console.warn("Unable to retrieve user location.", err);
    }
  }

  function buildVeinPath(width, height, seed = 0) {
    const startX = width * (0.08 + ((seed * 23) % 11) * 0.06);
    const startY = height * (0.12 + ((seed * 19) % 9) * 0.07);
    const c1x = width * (0.24 + ((seed * 17) % 10) * 0.05);
    const c1y = height * (0.08 + ((seed * 13) % 10) * 0.07);
    const c2x = width * (0.56 + ((seed * 29) % 10) * 0.04);
    const c2y = height * (0.18 + ((seed * 31) % 9) * 0.08);
    const endX = width * (0.82 + ((seed * 37) % 6) * 0.025);
    const endY = height * (0.26 + ((seed * 41) % 9) * 0.07);
    return `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`;
  }

  function cityGroupBounds(groupKeys, keyToPointMap) {
    const pts = groupKeys.map((k) => keyToPointMap.get(k)).filter(Boolean);
    if (!pts.length) return null;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    pts.forEach((pt) => {
      minX = Math.min(minX, pt[0]);
      minY = Math.min(minY, pt[1]);
      maxX = Math.max(maxX, pt[0]);
      maxY = Math.max(maxY, pt[1]);
    });
    return { minX, minY, maxX, maxY };
  }

  function buildRiftZones(cities, projection, width, height) {
    const metroGroups = [
      ["Los Angeles,CA", "San Diego,CA", "San Jose,CA"],
      ["Dallas,TX", "Houston,TX", "Chicago,IL"],
      ["New York,NY", "Philadelphia,PA", "Boston,MA", "Washington,DC"]
    ];

    const keyToPointMap = new Map();
    cities.forEach((city) => {
      const key = cityKey(city);
      const pt = projection([city.lon, city.lat]);
      if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
        keyToPointMap.set(key, pt);
      }
    });

    const zones = [];
    metroGroups.forEach((groupKeys, idx) => {
      const bounds = cityGroupBounds(groupKeys, keyToPointMap);
      if (!bounds) return;
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const rx = Math.max((bounds.maxX - bounds.minX) * 0.8, width * (idx === 2 ? 0.11 : 0.1));
      const ry = Math.max((bounds.maxY - bounds.minY) * 1.4, height * 0.09);
      const angle = idx === 0 ? -20 : (idx === 1 ? 8 : -24);
      zones.push({
        id: `metro-rift-${idx + 1}`,
        cx,
        cy,
        rx,
        ry,
        angle,
        intensity: "high"
      });
    });

    if (!zones.length) {
      zones.push(
        { id: "fallback-a", cx: width * 0.24, cy: height * 0.30, rx: width * 0.2, ry: height * 0.12, angle: -18, intensity: "high" },
        { id: "fallback-b", cx: width * 0.58, cy: height * 0.52, rx: width * 0.24, ry: height * 0.14, angle: 14, intensity: "high" },
        { id: "fallback-c", cx: width * 0.8, cy: height * 0.33, rx: width * 0.17, ry: height * 0.1, angle: -28, intensity: "medium" }
      );
    }

    const lockedMetroKeys = new Set(metroGroups.flat());
    return { zones, lockedMetroKeys };
  }

  function pointInRiftZone(pt, zone) {
    if (!pt || !zone) return false;
    const dx = pt[0] - zone.cx;
    const dy = pt[1] - zone.cy;
    const rad = (zone.angle * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const rx = (dx * cosA) + (dy * sinA);
    const ry = (-dx * sinA) + (dy * cosA);
    const normalized = ((rx * rx) / (zone.rx * zone.rx)) + ((ry * ry) / (zone.ry * zone.ry));
    return normalized <= 1;
  }

  function annotateRiftState(cities, zones, lockedMetroKeys = new Set()) {
    for (const city of cities) {
      const pt = city?._xy;
      const hit = Array.isArray(zones) ? zones.find((zone) => pointInRiftZone(pt, zone)) : null;
      const locked = lockedMetroKeys.has(cityKey(city));
      city._riftZone = hit || (locked ? { id: "metro-lock", intensity: "high" } : null);
      city._inRift = !!hit || locked;
    }
  }

  function renderUpsideDownTerrain(width, height) {
    gTerrain.selectAll("*").remove();
    if (!isUpsideDownMode) return [];

    gTerrain
      .append("rect")
      .attr("class", "terrain-corruption-haze")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", width)
      .attr("height", height);

    gTerrain
      .append("rect")
      .attr("class", "terrain-corruption-grain")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", width)
      .attr("height", height);

    const veinLayer = gTerrain.append("g").attr("class", "terrain-veins");
    const veinCount = 9;
    for (let i = 0; i < veinCount; i += 1) {
      veinLayer
        .append("path")
        .attr("class", `terrain-vein terrain-vein-${(i % 3) + 1}`)
        .attr("d", buildVeinPath(width, height, i + 1));
    }

    const built = buildRiftZones(activeCities, projection, width, height);
    return built;
  }

  function renderRiftOverlay(width, height, riftZones) {
    gRifts.selectAll("*").remove();
    if (!isUpsideDownMode || !Array.isArray(riftZones) || riftZones.length === 0) return;

    const riftLayer = gRifts.append("g").attr("class", "terrain-rifts");
    riftZones.forEach((zone, idx) => {
      riftLayer
        .append("ellipse")
        .attr("class", `rift-zone ${zone.intensity === "high" ? "is-high" : "is-medium"}`)
        .attr("cx", zone.cx)
        .attr("cy", zone.cy)
        .attr("rx", zone.rx * 1.03)
        .attr("ry", zone.ry * 1.03)
        .attr("transform", `rotate(${zone.angle} ${zone.cx} ${zone.cy})`)
        .style("animation-delay", `${idx * 0.9}s`);

      riftLayer
        .append("ellipse")
        .attr("class", `rift-core ${zone.intensity === "high" ? "is-high" : "is-medium"}`)
        .attr("cx", zone.cx)
        .attr("cy", zone.cy)
        .attr("rx", zone.rx * 0.56)
        .attr("ry", zone.ry * 0.4)
        .attr("transform", `rotate(${zone.angle - 8} ${zone.cx} ${zone.cy})`)
        .style("animation-delay", `${idx * 1.2}s`);
    });

    const boltA = `M ${width * 0.09} ${height * 0.24} C ${width * 0.24} ${height * 0.14}, ${width * 0.52} ${height * 0.56}, ${width * 0.84} ${height * 0.34}`;
    const boltB = `M ${width * 0.16} ${height * 0.66} C ${width * 0.34} ${height * 0.54}, ${width * 0.62} ${height * 0.78}, ${width * 0.9} ${height * 0.58}`;
    riftLayer.append("path").attr("class", "rift-lightning").attr("d", boltA);
    riftLayer.append("path").attr("class", "rift-lightning is-secondary").attr("d", boltB);
  }

  function render(us) {
    const node = document.getElementById("map");
    const width = Math.max(320, node.clientWidth); const height = Math.max(420, node.clientHeight);
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    mapWidth = width; mapHeight = height;

    const states = topojson.feature(us, us.objects.states);
    const nationFeature = topojson.feature(us, us.objects.nation);
    const stateBorders = topojson.mesh(us, us.objects.states, (a,b)=>a!==b);
    const nationOutline = topojson.mesh(us, us.objects.nation, (a,b)=>a===b);

    projection = d3.geoAlbersUsa().fitSize([width, height], states);
    path = d3.geoPath(projection);

    gLand.selectAll("*").remove(); gTerrain.selectAll("*").remove(); gSurface.selectAll("*").remove(); gBorders.selectAll("*").remove(); gRifts.selectAll("*").remove();
    gLand.selectAll("path.state-fill").data(states.features).join("path").attr("class", "state-fill").attr("d", path);
    landClipPath.datum(nationFeature).attr("d", path);
    const riftBuild = renderUpsideDownTerrain(width, height) || { zones: [], lockedMetroKeys: new Set() };
    const riftZones = Array.isArray(riftBuild?.zones) ? riftBuild.zones : [];
    const lockedMetroKeys = riftBuild?.lockedMetroKeys instanceof Set ? riftBuild.lockedMetroKeys : new Set();
    gBorders.append("path").datum(stateBorders).attr("class", "state-borders").attr("d", path);
    gBorders.append("path").datum(nationOutline).attr("class", "nation-outline").attr("d", path);
    renderRiftOverlay(width, height, riftZones);

    const citySel = gCities.selectAll("g.city").data(activeCities, d => `${d.city}-${d.state}`).join(enter => {
        const g = enter.append("g").attr("class", "city");
        g.append("circle").attr("class", "hit-area").attr("r", 11).style("fill", "transparent");
        g.append("circle").attr("class", "hover-ring").attr("r", 4.85).style("fill", "none");
        g.append("circle").attr("class", "city-dot").attr("r", 4.85).style("fill", LOADING_COLOR);
        g.append("line").attr("class", "wind-arrow").attr("x1", 7).attr("y1", 2).attr("x2", 15).attr("y2", -4).style("display", "none");
        g.append("circle").attr("class", "particle-rain").attr("cx", -2).attr("cy", 9).attr("r", 1.5).style("display", "none");
        g.append("circle").attr("class", "particle-snow").attr("cx", 2).attr("cy", 9).attr("r", 1.7).style("display", "none");
        g.append("circle").attr("class", "particle-ash particle-ash-a").attr("cx", 0).attr("cy", 9).attr("r", 1.6).style("display", "none");
        g.append("circle").attr("class", "particle-ash particle-ash-b").attr("cx", 2.4).attr("cy", 11).attr("r", 1.2).style("display", "none");
        g.append("line").attr("class", "particle-filament").attr("x1", -1).attr("y1", 8).attr("x2", -1).attr("y2", 14).style("display", "none");
        g.append("text")
          .attr("class", "memory-star")
          .attr("dx", -10)
          .attr("dy", -7)
          .text("★")
          .style("display", "none")
          .on("click", async (event, d) => {
            event.stopPropagation();
            const key = cityKey(d);
            const list = memoriesForCityKey(key);
            if(list.length === 0) return;
            if(list.length === 1){
              await jumpToMemoryDate(list[0]);
              showTooltip(event, d);
              return;
            }
            openMemoryJournal(key);
          });
        appendWeatherIconGlyph(g, "city-weather-icon");

        g.on("mouseenter", (event, d) => { if(isTouchContext(event)) return; animateHoverRing(d); showTooltip(event, d); })
         .on("mousemove", (event) => { if(isTouchContext(event)) return; moveTooltip(event); })
         .on("mouseleave", (event) => { if(isTouchContext(event)) return; hideTooltip(); })
         .on("click", (event, d) => {
           event.stopPropagation();
           const k = cityKey(d);
           if(isTouchContext(event)){
             const now = Date.now();
             const isSecondTapSameCity = (_hoverCityKey === k && lastTouchCityKey === k && (now - lastTouchTs) < 1800);
             if(!isSecondTapSameCity){
               animateHoverRing(d);
               showTooltip(event, d);
               lastTouchCityKey = k;
               lastTouchTs = now;
               return;
             }
             if(isPinningDisabledMode()){
               hideTooltip();
               lastTouchCityKey = null;
               return;
             }
             togglePin(d);
             lastTouchCityKey = null;
             return;
           }
           togglePin(d);
         });
        return g;
      });

    citySel.attr("transform", d => {
      const p = projection([d.lon, d.lat]); d._xy = p || null;
      if (!p) return "translate(-999,-999)"; return `translate(${p[0]},${p[1]})`;
    });

    annotateRiftState(activeCities, riftZones, lockedMetroKeys);
    citySel.classed("in-rift", (d) => !!d._inRift);

    citySel.select("circle.particle-ash-a").style("animation-delay", (_, i) => `${(i % 9) * 0.26}s`);
    citySel.select("circle.particle-ash-b").style("animation-delay", (_, i) => `${(i % 7) * 0.31}s`);
    citySel.select("line.particle-filament").style("animation-delay", (_, i) => `${(i % 6) * 0.34}s`);

    updateMemoryStars();
    updateUserLocationMarker();
    updateClusterLayout(lastZoomTransform?.k || 1);
    applyDotColors(false); updatePinnedStyles(); initZoom(width, height);
  }

  async function loadAllWeather(opts = {}) {
    const force = !!opts.force;
    let done = 0; let failed = 0; let cacheHits = 0; let netOk = 0;

    for (const c of activeCities) {
      c._wxError = false; c._pulsed = false;
      const cached = readCache(c);
      if (cached) { c._wx = cached.payload; c._wxMeta = { source: "cache", fetchedAt: cached.fetchedAt }; cacheHits += 1; } 
      else { c._wx = undefined; c._wxMeta = { source: "none", fetchedAt: null }; }
    }

    computeScaleFromLoaded(false); applyDotColors(false); if (pinned.size > 0) renderPinnedPanel();
    setProgress(0, activeCities.length, 0);
    if (cacheHits > 0) { setStatus(`Loaded cached weather for ${cacheHits}/${activeCities.length} cities. Refreshing…`); } 
    else { setStatus(`Fetching weather… (0/${activeCities.length})`); }

    await asyncPool(CONCURRENCY, activeCities, async (city) => {
      const needsNet = force || shouldRefreshFromNetwork(city);
      if (needsNet) {
        try {
          const wx = await fetchWeatherNetwork(city); const fetchedAt = Date.now();
          city._wx = wx; city._wxError = false; city._wxMeta = { source: "live", fetchedAt };
          writeCache(city, wx, fetchedAt); netOk += 1;
          if (!city._pulsed) { city._pulsed = true; pulseDotOnce(city); }
          refreshTooltipIfHovering(city);
        } catch (err) {
          if (!(city._wx && city._wxMeta?.source === "cache")) { city._wx = null; city._wxError = true; city._wxMeta = { source: "none", fetchedAt: null }; failed += 1; }
        }
      }
      computeScaleFromLoaded(true); if (pinned.size > 0) renderPinnedPanel();
      done += 1; setProgress(done, activeCities.length, failed); setStatus(`Fetching weather… (${done}/${activeCities.length})`);
    });

    const ok = activeCities.length - failed; const cacheMsg = cacheHits ? ` (cached ${cacheHits})` : "";
    setStatus(`Done. Updated ${ok}/${activeCities.length} cities${cacheMsg}${failed ? ` (${failed} unavailable)` : ""}. Hover a dot for details. Click a dot to pin.`);
    
    // Auto-detect current hour on initial load
    if (selectedHourIndex === 0 && !opts.force) {
      const currentHrStr = new Date().toISOString().slice(0,13) + ":00";
      const sample = activeCities.find(c => c._wx?.hourly?.time);
      if (sample) {
        const idx = sample._wx.hourly.time.findIndex(t => t >= currentHrStr);
        if (idx !== -1) { selectedHourIndex = idx; if (daySlider) daySlider.value = selectedHourIndex; updateDayLabelUI(); }
      }
    }

    computeScaleFromLoaded(false); applyDotColors(false);
    requestAnimationFrame(() => { computeScaleFromLoaded(false); applyDotColors(false); });
    renderPinnedPanel();
  }

  async function main() {
    try {
      await fetchTopCitiesCatalog();
      loadSavedUserLocation();
      await fetchMemories();
      await fetchColdestDays();
      fetchSportsSchedules().catch((e) => console.error(e));
      setStatus("Loading map…"); const us = await loadUSAtlasStates(); cachedUSMap = us; render(us);
      setStatus("Map ready. Fetching weather…"); await loadAllWeather();
      computeScaleFromLoaded(false); applyDotColors(false);
    } catch (e) { setStatus("Error loading map or weather. Check your internet connection."); }
  }

  refreshBtn.addEventListener("click", async () => { colorScale = null; lastMinHigh = null; lastMaxHigh = null; applyDotColors(false); updateLegend(); await loadAllWeather({ force: true }); if (colorMode === "aqi") loadAllAQI(); fetchSportsSchedules().catch((e) => console.error(e)); });
  zoomInBtn.addEventListener("click", () => { svg.transition().duration(200).call(zoom.scaleBy, 1.25); });
  zoomOutBtn.addEventListener("click", () => { svg.transition().duration(200).call(zoom.scaleBy, 0.8); });
  resetBtn.addEventListener("click", resetView);
  if(locateBtn) locateBtn.addEventListener("click", locateUser);
  if(copyLinkBtn) copyLinkBtn.addEventListener("click", copyPermalinkToClipboard);
  if(addCityBtn) addCityBtn.addEventListener("click", () => setAddCityModalVisible(true));
  if(addCityMenuBtn) addCityMenuBtn.addEventListener("click", () => {
    closeActionMenus();
    setAddCityModalVisible(true);
  });
  if(logMemoryBtn) logMemoryBtn.addEventListener("click", () => setMemoryFormVisible(memoryFormWrap?.hidden !== false));
  if(memoryCancelBtn) memoryCancelBtn.addEventListener("click", () => setMemoryFormVisible(false));
  if(memoryJournalClose) memoryJournalClose.addEventListener("click", () => setMemoryJournalVisible(false));
  if(addCityClose) addCityClose.addEventListener("click", () => setAddCityModalVisible(false));
  if(addCityCancel) addCityCancel.addEventListener("click", () => setAddCityModalVisible(false));
  if(addCityModal){
    addCityModal.addEventListener("click", (e) => {
      if(e.target === addCityModal && !isSubmittingAddCity){
        setAddCityModalVisible(false);
      }
    });
  }
  if(addCityStateInput){
    addCityStateInput.addEventListener("input", () => {
      addCityStateInput.value = String(addCityStateInput.value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0,2);
    });
  }
  if(addCityForm){
    addCityForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await submitAddCity();
    });
  }
  if(memoryJournalModal){
    memoryJournalModal.addEventListener("click", (e) => {
      if(e.target === memoryJournalModal){
        setMemoryJournalVisible(false);
      }
    });
  }
  if(memoryJournalList){
    memoryJournalList.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if(!btn) return;
      const action = btn.getAttribute("data-action");
      const id = Number(btn.getAttribute("data-id"));
      if(!Number.isInteger(id) || id <= 0) return;
      const targetMemory = memoriesData.find((m) => Number(m.id) === id);
      if(!targetMemory) return;
      if(action === "revisit"){
        setMemoryJournalVisible(false);
        await jumpToMemoryDate(targetMemory);
        const city = activeCities.find((c) => cityKey(c) === targetMemory.city_key);
        if(city && tooltipEl && _lastTooltipPt){
          showTooltip(_lastTooltipPt, city);
        }
        return;
      }
      if(action === "delete"){
        try{
          await deleteMemoryById(id);
        } catch(err){
          console.error(err);
          setStatus("Could not delete memory.");
        }
      }
    });
  }
  if(memoryForm){
    memoryForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await submitMemory(); }
      catch(err){ console.error(err); setStatus("Could not save memory."); }
    });
  }

  if(daySlider){
    daySlider.addEventListener("input", () => {
      selectedHourIndex = Math.max(0, Math.min(71, +daySlider.value || 0));
      updateDayLabelUI(); computeScaleFromLoaded(); renderPinnedPanel(); schedulePermalinkUpdate();
      if (isPlaying) { isPlaying = false; playBtn.textContent = "▶️"; clearInterval(playInterval); }
    });
  }

  if(playBtn) {
    playBtn.addEventListener('click', () => {
      isPlaying = !isPlaying;
      playBtn.textContent = isPlaying ? "⏸️" : "▶️";
      if (isPlaying) {
        playInterval = setInterval(() => {
          selectedHourIndex++;
          if (selectedHourIndex > 71) selectedHourIndex = 0;
          if (daySlider) daySlider.value = selectedHourIndex;
          updateDayLabelUI(); computeScaleFromLoaded(true); renderPinnedPanel();
        }, 500); 
      } else {
        clearInterval(playInterval);
      }
    });
  }

  if(pinnedListEl){
    pinnedListEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button.pinRemove"); if(!btn) return;
      const k = btn.getAttribute("data-key"); if(!k) return;
      pinned.delete(k); savePinned(); renderPinnedPanel(); updatePinnedStyles(); schedulePermalinkUpdate();
    });
  }

  svg.on("click", () => hideTooltip());
  window.addEventListener("resize", debounce(async () => { try { const us = await loadUSAtlasStates(); cachedUSMap = us; render(us); } catch {} }));

  initHistoricalDateInput();
  setAQIOptionEnabled(true);
  if(tmDateWrap) tmDateWrap.hidden = true;
  if(sportsFilterToggle){
    isSportsFilterActive = !!sportsFilterToggle.checked;
  }

  function closeActionMenus(exceptMenu = null){
    for(const menu of actionMenus){
      if(exceptMenu && menu === exceptMenu) continue;
      menu.open = false;
      const summary = menu.querySelector("summary");
      if(summary) summary.setAttribute("aria-expanded", "false");
    }
  }

  for(const menu of actionMenus){
    const summary = menu.querySelector("summary");
    const panel = menu.querySelector(".actionPanel");
    if(summary){
      summary.setAttribute("role", "button");
      summary.setAttribute("aria-haspopup", "menu");
      summary.setAttribute("aria-expanded", menu.open ? "true" : "false");
      summary.addEventListener("keydown", (e) => {
        if(e.key === "ArrowDown"){
          e.preventDefault();
          if(!menu.open){
            closeActionMenus(menu);
            menu.open = true;
            summary.setAttribute("aria-expanded", "true");
          }
          const firstFocusable = panel?.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
          if(firstFocusable) firstFocusable.focus();
        }
      });
    }
    menu.addEventListener("toggle", () => {
      if(menu.open){
        closeActionMenus(menu);
        if(summary) summary.setAttribute("aria-expanded", "true");
      } else if(summary){
        summary.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.addEventListener("click", (e) => {
    const inside = e.target instanceof Element && e.target.closest("details.actionMenu");
    if(!inside) closeActionMenus();
  });

  document.addEventListener("keydown", (e) => {
    if(e.key !== "Escape") return;
    if(addCityModal && !addCityModal.hidden && !isSubmittingAddCity){
      e.preventDefault();
      setAddCityModalVisible(false);
      return;
    }
    const openMenu = actionMenus.find((m) => m.open);
    if(!openMenu) return;
    e.preventDefault();
    closeActionMenus();
    const summary = openMenu.querySelector("summary");
    if(summary) summary.focus();
  });
  populateMemoryCityOptions();
  if(memoryDateInput){
    memoryDateInput.value = isoDate(new Date());
    memoryDateInput.max = getHistoricalStartMaxISO();
  }
  setMemoryFormVisible(false);
  setMemoryJournalVisible(false);
  setAddCityModalVisible(false);

  const _urlState = readPermalinkFromURL();
  if(_urlState){
    applyPermalinkState(_urlState);
    if(!_urlState.pins) loadPinned();
    if(daySlider) daySlider.value = String(selectedHourIndex);
    updateDayLabelUI();
    updateModeUXHints();
  } else {
    if(daySlider) selectedHourIndex = Math.max(0, Math.min(71, +daySlider.value || 0));
    updateDayLabelUI(); if(daySlider) daySlider.value = String(selectedHourIndex);
    updateModeUXHints();
    loadPinned(); suppressPermalink = false;
  }
  renderPinnedPanel(); main();
  }
  start();




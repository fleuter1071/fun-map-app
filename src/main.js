const statusEl = document.getElementById('statusText');
const statusChipEl = document.getElementById('legendStatus');
const statusIconEl = document.getElementById('legendStatusIcon');
const progressTrackEl = document.getElementById('progressTrack');
const progressFillEl = document.getElementById('progressFill');
let legendStatusTimer = null;

const LOADING_COLOR = "rgba(148,163,184,0.35)";
const ERROR_COLOR = "rgba(100,116,139,0.85)";
const LEGEND_STATUS_AUTO_DISMISS_MS = 2600;
const LEGEND_STATUS_WARNING_DISMISS_MS = 4200;

// Clustering configuration. Adjust radiusPx to tune collision avoidance aggressiveness.
const CLUSTER_CONFIG = {
  radiusPx: 16,
  minPoints: 2
};

function setProgress(done, total, failed = 0){
  if(!progressTrackEl || !progressFillEl || !statusChipEl) return;
  const pct = total ? Math.max(0, Math.min(1, done / total)) : 0;
  statusChipEl.dataset.progressVisible = total > 0 ? "true" : "false";
  progressFillEl.style.width = `${(pct * 100).toFixed(1)}%`;
  if(done >= total){
    progressTrackEl.style.opacity = "0.65";
  } else {
    progressTrackEl.style.opacity = "1";
  }
}

function clearLegendStatus({ immediate = false } = {}){
  if(legendStatusTimer){
    clearTimeout(legendStatusTimer);
    legendStatusTimer = null;
  }
  if(!statusChipEl) return;
  statusChipEl.dataset.progressVisible = "false";
  statusChipEl.classList.add("is-hidden");
  if(immediate && statusEl){
    statusEl.textContent = "";
  }
}

function showLegendStatus(message, type = "info", options = {}){
  if(!statusChipEl || !statusEl) return;
  if(legendStatusTimer){
    clearTimeout(legendStatusTimer);
    legendStatusTimer = null;
  }
  const persist = !!options.persist;
  const duration = options.duration ?? (type === "warning" || type === "error" ? LEGEND_STATUS_WARNING_DISMISS_MS : LEGEND_STATUS_AUTO_DISMISS_MS);
  statusEl.textContent = message;
  statusChipEl.dataset.statusType = type;
  statusChipEl.dataset.progressVisible = options.showProgress ? "true" : "false";
  if(statusIconEl){
    statusIconEl.dataset.statusType = type;
  }
  statusChipEl.classList.remove("is-hidden");
  if(!persist){
    legendStatusTimer = setTimeout(() => clearLegendStatus(), duration);
  }
}

function setStatus(message, options = {}){
  showLegendStatus(message, options.type || "info", options);
}

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
    setStatus('Loading libraries…', { type: 'loading', persist: true });
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
    setStatus('Libraries unavailable', { type: 'error', persist: true, duration: 5200 });
  }
}
function startApp(){
  const CLUSTER_DOT_RADIUS = 12;
  const MARKER_SYSTEM = {
    baseRadius: 4.5,
    promotedRadius: 5.1,
    focusRadius: 6.2,
    promotedBadge: { w: 72, h: 24, pad: 4 },
    focusBadge: { w: 132, h: 36, pad: 6 },
    hoverFocusBadge: { w: 72, h: 24, pad: 6 },
    promotionCapByZoom: [
      { maxK: 1.35, cap: 8 },
      { maxK: 2.2, cap: 14 },
      { maxK: 3.5, cap: 18 },
      { maxK: 99, cap: 26 }
    ]
  };
  let clusterState = {
    zoomK: 1,
    clusters: [],
    cityToCluster: new Map()
  };
  let markerState = {
    zoomK: 1,
    byKey: new Map(),
    promotedKeys: new Set(),
    focusKeys: new Set()
  };
  let promotedSelectionCache = {
    signature: "",
    orderedKeys: []
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
      if(city && typeof cityKey === "function"){
        const key = cityKey(city);
        const tier = markerState?.byKey?.get?.(key)?.tier || "base";
        if(tier !== "base"){
          icon.style("display", "none");
          return;
        }
      }
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
  const WEATHER_FETCH_TIMEOUT_HIST_MS = 12000;
  const WEATHER_FETCH_RETRIES_HIST = 2;
  const CONCURRENCY = 8;
  const CONCURRENCY_HIST = 3;
  const CACHE_VERSION = 6;

  const tooltipEl = document.getElementById('tooltip');

  let _hoverCityKey = null;
  let _lastTooltipPt = null;

  function setHoverState(city, event){
    _hoverCityKey = city ? cityKey(city) : null;
    if(event && event.clientX != null && event.clientY != null) _lastTooltipPt = {clientX: event.clientX, clientY: event.clientY};
    refreshMarkerSystem(lastZoomTransform?.k || 1);
  }

  function clearHoverState(){
    _hoverCityKey = null;
    _lastTooltipPt = null;
    refreshMarkerSystem(lastZoomTransform?.k || 1);
  }

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
  const timelineStateChipEl = document.getElementById("timelineStateChip");
  const timelineStateTextEl = document.getElementById("timelineStateText");
  const returnLiveBtn = document.getElementById("returnLiveBtn");
  const colorModeSelect = document.getElementById("colorModeSelect");
  const surfaceToggle = document.getElementById("surfaceToggle");
  const sportsFilterToggle = document.getElementById("sportsFilterToggle");
  const timeMachineToggle = document.getElementById("timeMachineToggle");
  const tmDateWrap = document.getElementById("tmDateWrap");
  const historicalDateInput = document.getElementById("historicalDateInput");
  const timeMachineNotice = document.getElementById("timeMachineNotice");
  const spookyThemeToggle = document.getElementById("spookyThemeToggle");
  const upsideDownToggle = document.getElementById("upsideDownToggle");
  const spookyAudioRow = document.getElementById("spookyAudioRow");
  const spookyAudioHint = document.getElementById("spookyAudioHint");
  const spookyAudioToggle = document.getElementById("spookyAudioToggle");
  const spookyAudioIcon = document.getElementById("spookyAudioIcon");
  const upsideDownAudioRow = document.getElementById("upsideDownAudioRow");
  const upsideDownAudioHint = document.getElementById("upsideDownAudioHint");
  const upsideDownAudioToggle = document.getElementById("upsideDownAudioToggle");
  const upsideDownAudioIcon = document.getElementById("upsideDownAudioIcon");
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
  const THEME_AUDIO_DEFAULT_VOLUME = 0.26;
  const THEME_AUDIO_CONFIG = {
    spooky: {
      src: "assets/audio/halloween-hip-hop.mp3",
      mutedKey: "uswx:spookyAudioMuted:v1",
      enabledKey: "uswx:spookyAudioEnabled:v1",
      rowEl: spookyAudioRow,
      hintEl: spookyAudioHint,
      buttonEl: spookyAudioToggle,
      iconEl: spookyAudioIcon,
      themeName: "Spooky"
    },
    upside: {
      src: "assets/audio/upside-down-theme.mp3",
      mutedKey: "uswx:upsideDownAudioMuted:v1",
      enabledKey: "uswx:upsideDownAudioEnabled:v1",
      rowEl: upsideDownAudioRow,
      hintEl: upsideDownAudioHint,
      buttonEl: upsideDownAudioToggle,
      iconEl: upsideDownAudioIcon,
      themeName: "Upside Down"
    }
  };
  const themeAudioState = {
    spooky: {
      audio: null,
      isMuted: false,
      isEnabled: false,
      isPlaying: false,
      isBlocked: false,
      volume: THEME_AUDIO_DEFAULT_VOLUME
    },
    upside: {
      audio: null,
      isMuted: false,
      isEnabled: false,
      isPlaying: false,
      isBlocked: false,
      volume: THEME_AUDIO_DEFAULT_VOLUME
    }
  };
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
  const TIME_MACHINE_LOCK_KEY = "uswx:tm:lockedUntil:v1";
  const TIME_MACHINE_LOCKED_REASON = "Time Machine reached the weather provider daily limit and is temporarily unavailable until tomorrow.";
  let userLocation = null;
  const USER_LOCATION_KEY = "userLocation:v1";
  let userLocationTagTimer = null;

  function readBoolLS(key, fallback = false){
    try {
      const raw = localStorage.getItem(key);
      if(raw == null) return fallback;
      if(raw === "true") return true;
      if(raw === "false") return false;
      const parsed = JSON.parse(raw);
      return typeof parsed === "boolean" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function writeBoolLS(key, value){
    try { localStorage.setItem(key, value ? "true" : "false"); } catch {}
  }

  function isThemeAudioActive(themeKey){
    if(themeKey === "upside") return isUpsideDownMode;
    return isSpookyMode && !isUpsideDownMode;
  }

  function initThemeAudio(themeKey){
    const state = themeAudioState[themeKey];
    const cfg = THEME_AUDIO_CONFIG[themeKey];
    if(state.audio) return state.audio;
    const audio = new Audio(cfg.src);
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = state.volume;
    audio.muted = !!state.isMuted;
    audio.addEventListener("play", () => {
      state.isPlaying = true;
      state.isBlocked = false;
      renderThemeAudioControls(themeKey);
    });
    audio.addEventListener("pause", () => {
      state.isPlaying = false;
      renderThemeAudioControls(themeKey);
    });
    audio.addEventListener("ended", () => {
      state.isPlaying = false;
      renderThemeAudioControls(themeKey);
    });
    audio.addEventListener("error", () => {
      state.isPlaying = false;
      state.isBlocked = false;
      renderThemeAudioControls(themeKey);
    });
    state.audio = audio;
    return audio;
  }

  function pauseThemeAudio(themeKey, { reset = false } = {}){
    const state = themeAudioState[themeKey];
    const audio = initThemeAudio(themeKey);
    audio.pause();
    state.isPlaying = false;
    state.isBlocked = false;
    if(reset){
      try { audio.currentTime = 0; } catch {}
    }
    renderThemeAudioControls(themeKey);
  }

  function setThemeAudioMuted(themeKey, nextMuted, { persist = true } = {}){
    const state = themeAudioState[themeKey];
    const cfg = THEME_AUDIO_CONFIG[themeKey];
    state.isMuted = !!nextMuted;
    const audio = initThemeAudio(themeKey);
    audio.muted = state.isMuted;
    audio.volume = state.volume;
    if(persist) writeBoolLS(cfg.mutedKey, state.isMuted);
    renderThemeAudioControls(themeKey);
  }

  async function playThemeAudio(themeKey, { userInitiated = false, forceEnable = false } = {}){
    const state = themeAudioState[themeKey];
    const cfg = THEME_AUDIO_CONFIG[themeKey];
    if(!isThemeAudioActive(themeKey)) return false;
    const audio = initThemeAudio(themeKey);
    audio.loop = true;
    audio.volume = state.volume;
    audio.muted = !!state.isMuted;
    if(forceEnable || userInitiated){
      state.isEnabled = true;
      writeBoolLS(cfg.enabledKey, true);
    }
    try{
      await audio.play();
      state.isPlaying = !audio.paused;
      state.isBlocked = false;
      if(!state.isMuted){
        state.isEnabled = true;
        writeBoolLS(cfg.enabledKey, true);
      }
      renderThemeAudioControls(themeKey);
      return true;
    } catch(err){
      state.isPlaying = false;
      state.isBlocked = !userInitiated;
      renderThemeAudioControls(themeKey);
      return false;
    }
  }

  async function enableThemeAudioFromUserAction(themeKey){
    const state = themeAudioState[themeKey];
    const cfg = THEME_AUDIO_CONFIG[themeKey];
    setThemeAudioMuted(themeKey, false);
    state.isEnabled = true;
    writeBoolLS(cfg.enabledKey, true);
    await playThemeAudio(themeKey, { userInitiated: true, forceEnable: true });
  }

  function syncThemeAudioWithThemeState(themeKey){
    const state = themeAudioState[themeKey];
    initThemeAudio(themeKey);
    if(!isThemeAudioActive(themeKey)){
      pauseThemeAudio(themeKey, { reset: true });
      renderThemeAudioControls(themeKey);
      return;
    }
    if(state.isMuted){
      pauseThemeAudio(themeKey, { reset: true });
      renderThemeAudioControls(themeKey);
      return;
    }
    if(document.hidden){
      pauseThemeAudio(themeKey);
      renderThemeAudioControls(themeKey);
      return;
    }
    playThemeAudio(themeKey, { userInitiated: false, forceEnable: state.isEnabled }).catch(() => {});
  }

  function renderThemeAudioControls(themeKey){
    const state = themeAudioState[themeKey];
    const cfg = THEME_AUDIO_CONFIG[themeKey];
    const rowEl = cfg.rowEl;
    const hintEl = cfg.hintEl;
    const buttonEl = cfg.buttonEl;
    const iconEl = cfg.iconEl;
    const isActive = isThemeAudioActive(themeKey);
    if(rowEl){
      rowEl.hidden = !isActive;
      if(isActive){
        const uiState = state.isPlaying && !state.isMuted
          ? "playing"
          : (state.isBlocked ? "blocked" : (state.isMuted ? "muted" : "ready"));
        rowEl.dataset.audioState = uiState;
      } else {
        delete rowEl.dataset.audioState;
      }
    }
    if(!isActive){
      if(hintEl) hintEl.textContent = "Ambient loop ready";
      if(iconEl) iconEl.textContent = "🔇";
      if(buttonEl){
        buttonEl.setAttribute("aria-label", `Enable ${cfg.themeName} theme audio`);
        buttonEl.setAttribute("aria-pressed", "false");
        buttonEl.disabled = true;
      }
      return;
    }
    const isAudible = state.isPlaying && !state.isMuted;
    let hint = "Theme audio available";
    let icon = "🔈";
    let label = `Enable ${cfg.themeName} theme audio`;
    if(isAudible){
      hint = "Theme audio on";
      icon = "🔊";
      label = `Mute ${cfg.themeName} theme audio`;
    } else if(state.isBlocked){
      hint = "Click to enable theme audio";
      icon = "▶";
      label = `Start ${cfg.themeName} theme audio`;
    } else if(state.isMuted){
      hint = "Audio muted";
      icon = "🔇";
      label = `Unmute ${cfg.themeName} theme audio`;
    }
    if(hintEl) hintEl.textContent = hint;
    if(iconEl) iconEl.textContent = icon;
    if(buttonEl){
      buttonEl.disabled = false;
      buttonEl.setAttribute("aria-label", label);
      buttonEl.setAttribute("aria-pressed", isAudible ? "true" : "false");
      buttonEl.title = hint;
    }
  }

  function getSelectedWeatherSnapshot(wx){
    const cur = wx?.current ?? {};
    const hourly = wx?.hourly ?? {};
    const idx = Math.max(0, Math.min(71, Number(selectedHourIndex) || 0));

    const hourlyAt = (arr, fallback = null) => {
      if (!Array.isArray(arr)) return fallback;
      const value = arr[idx];
      return (value != null && Number.isFinite(Number(value))) ? Number(value) : fallback;
    };
    const hourlyAtRaw = (arr, fallback = null) => {
      if (!Array.isArray(arr)) return fallback;
      const value = arr[idx];
      return value == null ? fallback : value;
    };

    const temp = hourlyAt(hourly.temp, Number.isFinite(Number(cur.temp)) ? Number(cur.temp) : null);
    const code = hourlyAt(hourly.code, Number.isFinite(Number(cur.code)) ? Number(cur.code) : null);
    const windSpeed = hourlyAt(hourly.windSpeed, Number.isFinite(Number(cur.windSpeed)) ? Number(cur.windSpeed) : null);
    const windDir = hourlyAt(hourly.windDir, Number.isFinite(Number(cur.windDir)) ? Number(cur.windDir) : null);
    const time = hourlyAtRaw(hourly.time, cur.time ?? null);
    const feels = Number.isFinite(Number(cur.feels)) && time && cur.time && String(time) === String(cur.time)
      ? Number(cur.feels)
      : temp;

    return {
      time,
      temp,
      feels,
      code,
      windSpeed,
      windDir,
      windGust: cur.windGust ?? null,
      humidity: cur.humidity ?? null,
      cloud: cur.cloud ?? null
    };
  }

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
      .style("display", "none");
  }

  async function jumpToMemoryDate(memory){
    if(isTimeMachineLocked()){
      const until = getTimeMachineLockedUntil();
      setStatus(`Historical unavailable`, { type: "warning", duration: 5200 });
      return;
    }
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

  function getTimeMachineLockedUntil(){
    try {
      const raw = localStorage.getItem(TIME_MACHINE_LOCK_KEY);
      const v = raw ? Number(raw) : 0;
      if(!Number.isFinite(v) || v <= 0) return 0;
      if(Date.now() >= v){
        localStorage.removeItem(TIME_MACHINE_LOCK_KEY);
        return 0;
      }
      return v;
    } catch {
      return 0;
    }
  }

  function lockTimeMachineUntilTomorrow(){
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 5, 0, 0);
    const ts = d.getTime();
    try { localStorage.setItem(TIME_MACHINE_LOCK_KEY, String(ts)); } catch {}
    return ts;
  }

  function formatLockUntil(ts){
    if(!Number.isFinite(ts) || ts <= 0) return "tomorrow";
    return new Date(ts).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  }

  function isTimeMachineLocked(){
    return getTimeMachineLockedUntil() > 0;
  }

  function applyTimeMachineAvailability(){
    const lockedUntil = getTimeMachineLockedUntil();
    const locked = lockedUntil > 0;
    if(timeMachineNotice){
      timeMachineNotice.hidden = !locked;
      timeMachineNotice.textContent = locked
        ? `${TIME_MACHINE_LOCKED_REASON} (Available again around ${formatLockUntil(lockedUntil)}.)`
        : "";
    }
    if(locked){
      isHistoricalMode = false;
      if(timeMachineToggle){
        timeMachineToggle.checked = false;
        timeMachineToggle.disabled = true;
      }
      if(tmDateWrap) tmDateWrap.hidden = true;
    } else if(timeMachineToggle){
      timeMachineToggle.disabled = false;
    }
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
    if(nextMode && isTimeMachineLocked()){
      isHistoricalMode = false;
      if(timeMachineToggle) timeMachineToggle.checked = false;
      if(tmDateWrap) tmDateWrap.hidden = true;
      const until = getTimeMachineLockedUntil();
      setStatus(`Historical unavailable`, { type: "warning", duration: 5200 });
      return;
    }
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
    if(isSpookyMode) isUpsideDownMode = false;
    if(spookyThemeToggle) spookyThemeToggle.checked = isSpookyMode;
    if(upsideDownToggle) upsideDownToggle.checked = isUpsideDownMode;
    if(isSpookyMode){
      activeCities = HORROR_CITIES;
    } else {
      activeCities = TOP_CITIES;
    }
    applyColdestToActiveCities();
    applyThemeAttribute();
    syncThemeAudioWithThemeState("spooky");
    syncThemeAudioWithThemeState("upside");
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
    if(isUpsideDownMode) isSpookyMode = false;
    if(upsideDownToggle) upsideDownToggle.checked = isUpsideDownMode;
    if(spookyThemeToggle) spookyThemeToggle.checked = isSpookyMode;
    activeCities = isSpookyMode ? HORROR_CITIES : TOP_CITIES;
    applyColdestToActiveCities();
    runThemeTransition(isUpsideDownMode);
    applyThemeAttribute();
    syncThemeAudioWithThemeState("upside");
    syncThemeAudioWithThemeState("spooky");
    clearPinsAndFocus();
    if(cachedUSMap) render(cachedUSMap);

    // Upside Down is a visual/UX mode; do not force historical weather.
    if(timeMachineToggle){
      const locked = isTimeMachineLocked();
      timeMachineToggle.disabled = locked;
      timeMachineToggle.checked = locked ? false : !!isHistoricalMode;
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
      if(isTimeMachineLocked()){
        timeMachineToggle.checked = false;
        const until = getTimeMachineLockedUntil();
        setStatus(`Historical unavailable`, { type: "warning", duration: 5200 });
        return;
      }
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

  if(spookyAudioToggle){
    spookyAudioToggle.addEventListener("click", async () => {
      const state = themeAudioState.spooky;
      if(!isSpookyMode) return;
      if(state.isPlaying && !state.isMuted){
        setThemeAudioMuted("spooky", true);
        return;
      }
      await enableThemeAudioFromUserAction("spooky");
    });
  }

  if(upsideDownAudioToggle){
    upsideDownAudioToggle.addEventListener("click", async () => {
      const state = themeAudioState.upside;
      if(!isUpsideDownMode) return;
      if(state.isPlaying && !state.isMuted){
        setThemeAudioMuted("upside", true);
        return;
      }
      await enableThemeAudioFromUserAction("upside");
    });
  }

  const PERMALINK_VERSION = 2;
  let permalinkReady = false;
  let suppressPermalink = true;
  let pendingZoomState = null;
  let focusedKey = null;
  let pendingFocusKey = null;
  let pinnedPanelTab = "overview";

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
    refreshMarkerSystem(lastZoomTransform?.k || 1);
  }

  function getPinnedKeysInView(){
    return Array.from(pinned.keys()).filter((k) => pinned.get(k));
  }

  function getActivePinnedKey(){
    const keys = getPinnedKeysInView();
    if(keys.length === 0) return null;
    if(focusedKey && pinned.has(focusedKey)) return focusedKey;
    return keys[keys.length - 1];
  }

  function setActivePinnedKey(nextKey, { syncFocus = true } = {}){
    const resolved = (nextKey && pinned.has(nextKey)) ? nextKey : getActivePinnedKey();
    focusedKey = resolved || null;
    if(syncFocus) applyFocusStyles();
    return focusedKey;
  }

  function availablePinnedTabsForCity(city){
    const tabs = [{ id: "overview", label: "Overview" }, { id: "forecast", label: "Forecast" }, { id: "profile", label: "Profile" }];
    const hasExtras = isSportsFilterActive && gamesForCityKey(cityKey(city)).length > 0;
    if(hasExtras) tabs.push({ id: "extras", label: "Extras" });
    return tabs;
  }

  function applyPinsFromKeys(keys){
    pinned.clear();
    for(const k of keys){
      const city = activeCities.find(d => `${d.city},${d.state}` === k);
      if(city){ pinned.set(k, city); ensureCensus(city); ensureAQI(city); }
    }
    setActivePinnedKey(focusedKey, { syncFocus: false });
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
  const legendMetricEl = document.getElementById('legendMetric');
  const mapHudEl = document.getElementById('mapHud');
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
  const gClusters = gRoot.append("g").attr("class", "clusters");
  const gCities = gRoot.append("g").attr("class", "cities");
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
      if (!res.ok){
        let detail = "";
        try { detail = (await res.text()).slice(0, 180); } catch {}
        throw new Error(`Fetch failed (${res.status})${detail ? `: ${detail}` : ""}`);
      }
      return await res.json();
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`Fetch timed out (${timeoutMs}ms)`);
      }
      throw err;
    } finally { clearTimeout(t); }
  }

  function isRetryableWeatherError(err){
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("429") || msg.includes("timed out") || msg.includes("network") || msg.includes("failed to fetch");
  }

  function isProviderDailyLimitError(err){
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("429") && (msg.includes("daily request limit exceeded") || msg.includes("try again tomorrow"));
  }

  function sleep(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        `&timezone=UTC&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    } else {
      url =
        `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
        `&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
        `&forecast_days=3&timezone=UTC&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    }

    const timeoutMs = useHistorical ? WEATHER_FETCH_TIMEOUT_HIST_MS : WEATHER_FETCH_TIMEOUT_MS;
    const retries = useHistorical ? WEATHER_FETCH_RETRIES_HIST : 0;
    let data = null;
    for(let attempt = 0; attempt <= retries; attempt++){
      try {
        data = await fetchJSONWithTimeout(url, timeoutMs);
        break;
      } catch (err) {
        if(attempt >= retries || !isRetryableWeatherError(err)) throw err;
        await sleep(350 * (attempt + 1));
      }
    }
    if(!data) throw new Error("No weather payload returned.");
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
      dailyCode: [data?.daily?.weather_code?.[0] ?? null, data?.daily?.weather_code?.[1] ?? null, data?.daily?.weather_code?.[2] ?? null],
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
    setStatus(`Loading AQI…`, { type: "loading", persist: true, showProgress: true });
    setProgress(0, activeCities.length, 0);
    let done = 0;
    const poolSize = isHistoricalMode ? CONCURRENCY_HIST : CONCURRENCY;
    await asyncPool(poolSize, activeCities, async (city) => {
      if (city._aqi === undefined) { try { city._aqi = await fetchAQINetwork(city); } catch(e) { city._aqi = null; } }
      done++; setProgress(done, activeCities.length, 0); computeScaleFromLoaded(true);
    });
    setStatus(`AQI updated`, { type: "success" });
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
    ensureAQI(d);

    const wx = d._wx;
    const movieTitle = String(d?.movie || "").trim();
    const movieYear = Number.isFinite(Number(d?.movieYear)) ? Number(d.movieYear) : null;
    const horrorHeroHTML = (isSpookyMode && movieTitle)
      ? `<div class="tooltip-horror-hero"><div class="tooltip-horror-label">Featured Horror</div><div class="tooltip-horror-movie">${escapeHTML(movieTitle)}${movieYear ? ` <span class="muted">(${movieYear})</span>` : ""}</div></div>`
      : "";
    const headerHTML = `<div class="tooltip-head"><div class="tooltip-city"><strong>${d.city}, ${d.state}</strong></div></div>`;
    const coldestDay = d?._coldest5y || wx?.coldestDay || null;
    const coldestSource = d?._coldest5y ? "5y" : "loaded";
    const coldestDateTxt = formatDateLong(coldestDay?.date);
    const coldestLowTxt = (coldestDay?.low != null && isFinite(coldestDay.low)) ? `${Math.round(coldestDay.low)}°F` : "—";
    const coldestSourceLabel = coldestSource === "5y" ? "last 5 years" : "loaded data window";
    const coldestInfoHTML = (colorMode === "coldest")
      ? `<div class="tooltip-context-row"><span class="tooltip-context-label">Coldest day</span><span class="tooltip-context-value">${coldestLowTxt} on ${coldestDateTxt} <span class="muted">(${coldestSourceLabel})</span></span></div>`
      : "";

    let aqiChip = "";
    if (d._aqi) {
      const stat = getAQIStatus(d._aqi.aqi);
      aqiChip = `<span class="chip" style="border-color:${stat.color};">AQI ${d._aqi.aqi} (${stat.label})</span>`;
    } else if (d._aqiLoading) {
      aqiChip = `<span class="chip" style="opacity:0.7;">Loading AQI...</span>`;
    }

    if (wx === undefined) {
      tooltipEl.style.display = "block";
      tooltipEl.innerHTML = `${headerHTML}${horrorHeroHTML}<div class="divider"></div><div class="tooltip-empty">Loading current conditions…</div>${aqiChip ? `<div class="chipRow">${aqiChip}</div>` : ""}<div class="tooltip-context"><div class="tooltip-context-row tooltip-context-row-inline"><span class="tooltip-context-label">More</span><span class="tooltip-context-value">Pin for more</span></div></div>`;
      tooltipEl.classList.remove("tooltip-enter");
      void tooltipEl.offsetWidth;
      tooltipEl.classList.add("tooltip-enter");
      moveTooltip(event); return;
    }

    if (d._wxError || !wx) {
      tooltipEl.style.display = "block";
      tooltipEl.innerHTML = `${headerHTML}${horrorHeroHTML}<div class="divider"></div><div class="tooltip-empty">${weatherBadgeHTML(d)} <span style="margin-left:6px;">Weather unavailable.</span></div>${aqiChip ? `<div class="chipRow">${aqiChip}</div>` : ""}<div class="tooltip-context"><div class="tooltip-context-row tooltip-context-row-inline"><span class="tooltip-context-label">More</span><span class="tooltip-context-value">Pin for more</span></div></div>`;
      tooltipEl.classList.remove("tooltip-enter");
      void tooltipEl.offsetWidth;
      tooltipEl.classList.add("tooltip-enter");
      moveTooltip(event); return;
    }

    const snap = getSelectedWeatherSnapshot(wx);
    const cond = wxCodeToIconLabel(snap.code);
    const temp = fmtInt(snap.temp); const feels = fmtInt(snap.feels);
    const hum = fmtInt(snap.humidity); const cloud = fmtInt(snap.cloud);
    const ws = fmtInt(snap.windSpeed);
    const wdir = degToCompass(snap.windDir);

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
    const wxMeta = d?._wxMeta;
    const updateLabel = (!wxMeta || !wxMeta.source)
      ? "No recent snapshot"
      : (wxMeta.source === "live"
          ? "Live now"
          : (wxMeta.fetchedAt ? `Cached ${formatAgeShort(Date.now() - wxMeta.fetchedAt)} ago` : "Cached"));
    const detailHint = showColdestMode ? "Hover only in Coldest Day" : "Pin for more";
    const quickContextRows = [
      coldestInfoHTML,
      `<div class="tooltip-context-row tooltip-context-row-inline"><span class="tooltip-context-label">Updated</span><span class="tooltip-context-value">${updateLabel}</span></div>`,
      `<div class="tooltip-context-row tooltip-context-row-inline"><span class="tooltip-context-label">More</span><span class="tooltip-context-value">${detailHint}</span></div>`
    ].filter(Boolean).join("");

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
      <div class="chipRow">
        <span class="chip metric-chip"><span>💧 Hum</span><strong>${hum}%</strong></span>
        <span class="chip metric-chip"><span>🌬️ Wind</span><strong>${ws} mph ${wdir}</strong></span>
        ${aqiChip || `<span class="chip metric-chip"><span>☁️ Clouds</span><strong>${cloud}%</strong></span>`}
      </div>
      <div class="tooltip-context">
        ${quickContextRows}
      </div>
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

  function getRoundedCurrentHourDate(){
    const d = new Date();
    if(d.getMinutes() >= 30) d.setHours(d.getHours() + 1);
    d.setMinutes(0, 0, 0);
    return d;
  }

  function parseHourlyTimestampMs(value){
    if(value == null) return NaN;
    if(typeof value === "number" && isFinite(value)){
      return value < 1e12 ? value * 1000 : value;
    }
    if(typeof value !== "string") return NaN;
    const raw = value.trim();
    if(!raw) return NaN;
    if(/^\d+$/.test(raw)){
      const n = Number(raw);
      return n < 1e12 ? n * 1000 : n;
    }
    // Weather API hourly strings are canonical UTC for timeline alignment.
    return Date.parse(raw.endsWith("Z") ? raw : `${raw}Z`);
  }

  function findTimelineIndexForCurrentHour(hourlyTimes){
    if(!Array.isArray(hourlyTimes) || hourlyTimes.length === 0) return 0;
    const target = getRoundedCurrentHourDate().getTime();
    let bestFutureIdx = -1;
    let nearestPastIdx = 0;
    for(let i = 0; i < hourlyTimes.length; i++){
      const ts = parseHourlyTimestampMs(hourlyTimes[i]);
      if(!Number.isFinite(ts)) continue;
      if(ts >= target){
        bestFutureIdx = i;
        break;
      }
      nearestPastIdx = i;
    }
    return bestFutureIdx >= 0 ? bestFutureIdx : nearestPastIdx;
  }

  function getLiveTimelineIndex(){
    const sampleCity = activeCities.find(c => c?._wx?.hourly?.time && c._wx.hourly.time.length > 0);
    if(!sampleCity) return 0;
    const idx = findTimelineIndexForCurrentHour(sampleCity._wx.hourly.time);
    return Math.max(0, Math.min(71, idx));
  }

  function syncTimelineStateUI(){
    if(!timelineStateChipEl || !timelineStateTextEl) return;
    if(isHistoricalMode){
      timelineStateChipEl.dataset.state = "historical";
      timelineStateTextEl.textContent = "HISTORICAL";
      if(returnLiveBtn) returnLiveBtn.hidden = true;
      return;
    }
    const liveIdx = getLiveTimelineIndex();
    const delta = selectedHourIndex - liveIdx;
    if(delta === 0){
      timelineStateChipEl.dataset.state = "live";
      timelineStateTextEl.textContent = "LIVE";
      if(returnLiveBtn) returnLiveBtn.hidden = true;
      return;
    }
    if(delta > 0){
      timelineStateChipEl.dataset.state = "ahead";
      timelineStateTextEl.textContent = "LOOKING AHEAD";
    } else {
      timelineStateChipEl.dataset.state = "back";
      timelineStateTextEl.textContent = "LOOKING BACK";
    }
    if(returnLiveBtn) returnLiveBtn.hidden = false;
  }

  function jumpToLiveHour(){
    if(isHistoricalMode) return;
    selectedHourIndex = getLiveTimelineIndex();
    if(daySlider) daySlider.value = String(selectedHourIndex);
    updateDayLabelUI();
    computeScaleFromLoaded(true);
    renderPinnedPanel();
    schedulePermalinkUpdate();
  }

  function getLegendMetricLabel(){
    if(colorMode === "aqi") return "AQI";
    if(colorMode === "coldest") return "Coldest";
    return colorMode === "precip" ? "Precip" : "Temp";
  }

  function formatLegendTimeLabel(timestampMs){
    if(!Number.isFinite(timestampMs)) return `+${selectedHourIndex}h`;
    const dt = new Date(timestampMs);
    const dow = dt.toLocaleDateString([], { weekday: "short" });
    const hour = dt.toLocaleTimeString([], { hour: "numeric" });
    return `${dow} ${hour}`;
  }

  function updateLegendContext(contextLabel){
    if(legendTagEl) legendTagEl.textContent = contextLabel;
    if(legendMetricEl) legendMetricEl.textContent = getLegendMetricLabel();
  }

  function updateDayLabelUI(){
    syncTimelineStateUI();
    if(colorMode === "aqi"){
       if(dayLabelEl) dayLabelEl.textContent = "Live AQI";
       updateLegendContext("Live");
       return;
    }
    if(colorMode === "coldest"){
      if(dayLabelEl) dayLabelEl.textContent = "Coldest";
      updateLegendContext("Loaded Window");
      return;
    }
    const sampleCity = activeCities.find(c => c._wx && c._wx.hourly && c._wx.hourly.time && c._wx.hourly.time.length > selectedHourIndex);
    if(sampleCity) {
      const ts = parseHourlyTimestampMs(sampleCity._wx.hourly.time[selectedHourIndex]);
      const formatted = formatLegendTimeLabel(ts);
      if(dayLabelEl) dayLabelEl.textContent = formatted;
      updateLegendContext(formatted);
    } else {
      const fallback = `+${selectedHourIndex}h`;
      if(dayLabelEl) dayLabelEl.textContent = fallback;
      updateLegendContext(fallback);
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
      const dailyCode = wx?.dailyCode?.[i];
      const fallbackHourlyCode = wx?.hourly?.code?.[(i * 24) + 12] ?? wx?.hourly?.code?.[i * 24] ?? null;
      const cond = wxCodeToIconLabel(dailyCode ?? fallbackHourlyCode);
      const h = (hi != null && isFinite(hi)) ? `${Math.round(hi)}°` : "—";
      const l = (lo != null && isFinite(lo)) ? `${Math.round(lo)}°` : "—";
      const p = (pr != null && isFinite(pr)) ? `${Math.round(pr)}%` : "—";
      return `<div class="pin-forecast-card ${i === currentDayIdx ? "is-current" : ""}"><div class="pin-forecast-top"><div class="pin-forecast-day">${formatDOW(ds)}</div></div><div class="pin-forecast-temp-row"><div class="pin-forecast-temp">${h} / ${l}</div><div class="pin-forecast-icon" title="${escapeHTML(cond.label)}">${cond.icon}</div></div><div class="pin-forecast-precip"><span class="pin-forecast-precip-chip">💧 ${p}</span></div></div>`;
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
      const dailyCode = wx?.dailyCode?.[i];
      const fallbackHourlyCode = wx?.hourly?.code?.[(i * 24) + 12] ?? wx?.hourly?.code?.[i * 24] ?? null;
      const cond = wxCodeToIconLabel(dailyCode ?? fallbackHourlyCode);
      const h = (hi != null && isFinite(hi)) ? `${Math.round(hi)}°` : "—";
      const l = (lo != null && isFinite(lo)) ? `${Math.round(lo)}°` : "—";
      const p = (pr != null && isFinite(pr)) ? `${Math.round(pr)}%` : "—";
      return `<div class="tooltip-forecast-card ${i === currentDayIdx ? "is-current" : ""}"><div class="tooltip-forecast-top"><div class="tooltip-forecast-day">${formatDOW(ds)}</div></div><div class="tooltip-forecast-temp-row"><div class="tooltip-forecast-temp">${h} / ${l}</div><div class="tooltip-forecast-icon" title="${escapeHTML(cond.label)}">${cond.icon}</div></div><div class="tooltip-forecast-precip"><span class="tooltip-forecast-precip-chip">💧 ${p}</span></div></div>`;
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
    const keys = getPinnedKeysInView();
    if(keys.length === 0){ pinnedPanelEl.style.display = "none"; pinnedListEl.innerHTML = ""; return; }
    pinnedPanelEl.style.display = "block";
    const activeKey = setActivePinnedKey(getActivePinnedKey(), { syncFocus: false });
    const activeCity = activeKey ? pinned.get(activeKey) : null;
    if(!activeCity){
      pinnedPanelEl.style.display = "none";
      pinnedListEl.innerHTML = "";
      return;
    }
    ensureCensus(activeCity);
    ensureAQI(activeCity);

    const railHTML = keys.map((k) => {
      const city = pinned.get(k);
      const wx = city?._wx;
      const snap = wx ? getSelectedWeatherSnapshot(wx) : null;
      const tempTxt = (snap?.temp != null && isFinite(snap.temp)) ? `${fmtInt(snap.temp)}°` : "—";
      const activeClass = k === activeKey ? " is-active" : "";
      return `<div class="pinRailItem${activeClass}"><button class="pinRailSelect" type="button" data-key="${k}" aria-pressed="${k === activeKey ? "true" : "false"}"><span class="pinRailCity">${escapeHTML(city.city)}</span><span class="pinRailTemp">${tempTxt}</span></button><button class="pinRailRemove" type="button" data-key="${k}" aria-label="Remove ${escapeHTML(city.city)}, ${escapeHTML(city.state)} from pinned cities">✕</button></div>`;
    }).join("");

    const wx = activeCity?._wx;
    const wxMeta = activeCity?._wxMeta || {};
    const pop = (activeCity?.pop != null) ? activeCity.pop.toLocaleString("en-US") : "—";
    const games = gamesForCityKey(cityKey(activeCity));
    const hasSports = isSportsFilterActive && games.length > 0;
    const tabs = availablePinnedTabsForCity(activeCity);
    if(!tabs.some((tab) => tab.id === pinnedPanelTab)) pinnedPanelTab = "overview";
    const tabButtons = tabs.map((tab) => `<button type="button" class="pinSegmentBtn${tab.id === pinnedPanelTab ? " is-active" : ""}" data-tab="${tab.id}" aria-pressed="${tab.id === pinnedPanelTab ? "true" : "false"}">${tab.label}</button>`).join("");

    let heroMain = "—";
    let heroSub = `<span class="pinInspectorMuted">Loading current conditions…</span>`;
    let metricCards = `<div class="pinMetricCard"><span class="pinMetricLabel">Status</span><strong class="pinMetricValue">Loading…</strong></div>`;
    let overviewMeta = "Loading weather";
    let forecastHTML = `<div class="pinInspectorEmpty">Loading forecast…</div>`;
    let summaryNote = "";

    if (activeCity?._wxError) {
      overviewMeta = "Weather unavailable";
      heroSub = `${weatherBadgeHTML(activeCity)} <span class="pinInspectorMuted">Weather unavailable.</span>`;
    } else if (wx) {
      const snap = getSelectedWeatherSnapshot(wx);
      const cond = wxCodeToIconLabel(snap.code);
      const temp = fmtInt(snap.temp);
      const feels = fmtInt(snap.feels);
      const hum = fmtInt(snap.humidity);
      const cloud = fmtInt(snap.cloud);
      const ws = fmtInt(snap.windSpeed);
      const wdir = degToCompass(snap.windDir);
      heroMain = `${temp}°F`;
      heroSub = `${cond.icon} ${cond.label} <span class="pinInspectorMuted">Feels ${feels}°F</span>`;
      const aqiValue = (activeCity?._aqi?.aqi != null && isFinite(activeCity._aqi.aqi))
        ? (() => {
            const stat = getAQIStatus(activeCity._aqi.aqi);
            return `<div class="pinMetricCard"><span class="pinMetricLabel">AQI</span><strong class="pinMetricValue" style="color:${stat.color}">${activeCity._aqi.aqi}</strong></div>`;
          })()
        : `<div class="pinMetricCard"><span class="pinMetricLabel">Clouds</span><strong class="pinMetricValue">${cloud}%</strong></div>`;
      metricCards = `<div class="pinMetricCard"><span class="pinMetricLabel">Humidity</span><strong class="pinMetricValue">${hum}%</strong></div><div class="pinMetricCard"><span class="pinMetricLabel">Wind</span><strong class="pinMetricValue">${ws} mph ${wdir}</strong></div>${aqiValue}`;
      overviewMeta = (wxMeta.source === "live")
        ? "Live now"
        : (wxMeta.source === "cache" ? (wxMeta.fetchedAt ? `Cached ${formatAgeShort(Date.now() - wxMeta.fetchedAt)} ago` : "Cached") : "No recent snapshot");
      forecastHTML = format3DayPills(activeCity);
    }

    const statusTags = [];
    if(isHistoricalMode) statusTags.push(`<span class="pinInspectorTag">Time Machine</span>`);
    if(colorMode === "coldest"){
      const coldestDay = activeCity?._coldest5y || activeCity?._wx?.coldestDay || null;
      const lowTxt = (coldestDay?.low != null && isFinite(coldestDay.low)) ? `${Math.round(coldestDay.low)}°F` : "—";
      const dateTxt = formatDateLong(coldestDay?.date);
      summaryNote = `<div class="pinInspectorNote"><span class="pinInspectorNoteLabel">Coldest day</span><span class="pinInspectorNoteValue">${lowTxt} on ${dateTxt}</span></div>`;
    }
    if(isUpsideDownMode) statusTags.push(`<span class="pinInspectorTag pinInspectorTag-upside">Upside Down</span>`);
    if(isUpsideDownMode && activeCity?._inRift) statusTags.push(`<span class="pinInspectorTag pinInspectorTag-rift">Rift Zone</span>`);
    if(wxMeta.source === "live") statusTags.push(`<span class="pinInspectorTag pinInspectorTag-live">Live</span>`);
    if(wxMeta.source === "cache") statusTags.push(`<span class="pinInspectorTag pinInspectorTag-cache">Cached</span>`);
    const statusTagsHTML = statusTags.length ? `<div class="pinInspectorTagRow">${statusTags.join("")}</div>` : "";

    const cen = activeCity?._census;
    const cenLoading = !!activeCity?._censusLoading;
    const cenErr = !!activeCity?._censusError;
    const baTxt = (cen && cen.bachelorsPct != null && isFinite(cen.bachelorsPct)) ? fmtPct1(cen.bachelorsPct) : (cenLoading ? "…" : "—");
    const incTxt = (cen && cen.medianIncome != null && isFinite(cen.medianIncome)) ? fmtUSDCompact(cen.medianIncome) : (cenLoading ? "…" : "—");
    const incTitle = (cen && cen.medianIncome != null && isFinite(cen.medianIncome)) ? fmtUSD(cen.medianIncome) : "";
    const profileHTML = `<div class="pinInfoList"><div class="pinInfoRow"><span class="pinInfoLabel">Population</span><span class="pinInfoValue">${pop}</span></div><div class="pinInfoRow"><span class="pinInfoLabel">Bachelor's+ (25+)</span><span class="pinInfoValue">${baTxt}</span></div><div class="pinInfoRow"><span class="pinInfoLabel">Median income</span><span class="pinInfoValue" ${incTitle ? `title="${incTitle}"` : ""}>${incTxt}</span></div></div><div class="pinTabFoot">Source: US Census <span class="infoIcon" title="${CENSUS_SOURCE_TITLE}">ⓘ</span></div>${cenErr ? `<div class="pinTabFoot">City profile unavailable.</div>` : ""}`;
    const extrasBlocks = [];
    if(hasSports){
      const byLeague = new Map();
      for(const g of games){
        const leagueKey = String(g.league || "Other");
        if(!byLeague.has(leagueKey)) byLeague.set(leagueKey, []);
        byLeague.get(leagueKey).push(g);
      }
      const sportsRows = Array.from(byLeague.entries()).map(([league, list]) => {
        const rows = list.map((g) => `<div class="pinSportsRow"><span class="pinSportsMatch">${g.emoji} ${escapeHTML(g.away)} @ ${escapeHTML(g.home)}</span><span class="pinSportsTime">${escapeHTML(g.timeET)} ET</span></div>`).join("");
        return `<div class="pinSportsGroup"><div class="pinSportsLeague">${escapeHTML(league)}</div>${rows}</div>`;
      }).join("");
      extrasBlocks.push(`<div class="pinTabSection"><div class="pinTabSectionTitle">Game Day</div><div class="pinSportsList">${sportsRows}</div></div>`);
    }
    const extrasHTML = extrasBlocks.length ? extrasBlocks.join("") : `<div class="pinInspectorEmpty">No extra city details right now.</div>`;

    let tabBody = "";
    if(pinnedPanelTab === "forecast"){
      tabBody = forecastHTML;
    } else if(pinnedPanelTab === "profile"){
      tabBody = profileHTML;
    } else if(pinnedPanelTab === "extras"){
      tabBody = extrasHTML;
    } else {
      tabBody = `<div class="pinInspectorOverview">${statusTagsHTML}<div class="pinInspectorHero"><div class="pinInspectorHeroMain">${heroMain}</div><div class="pinInspectorHeroSub">${heroSub}</div></div><div class="pinInspectorMeta">${overviewMeta}</div><div class="pinInspectorMetrics">${metricCards}</div>${summaryNote}</div>`;
    }

    pinnedListEl.innerHTML = `
      <div class="pinInspectorShell">
        <div class="pinRail" aria-label="Pinned cities">${railHTML}</div>
        <div class="pinInspectorBody">
          <div class="pinInspectorHeader">
            <div>
              <div class="pinInspectorCity">${escapeHTML(activeCity.city)}, ${escapeHTML(activeCity.state)}</div>
            </div>
            <button class="pinInspectorRemove" type="button" data-key="${activeKey}" aria-label="Remove ${escapeHTML(activeCity.city)}, ${escapeHTML(activeCity.state)} from pinned cities">×</button>
          </div>
          <div class="pinSegmented" aria-label="Pinned city details">${tabButtons}</div>
          <div class="pinTabBody">${tabBody}</div>
        </div>
      </div>
    `;
  }

  function updatePinnedStyles(){
    const isPinned = d => !isPinningDisabledMode() && pinned.has(cityKey(d));
    const disablePins = isPinningDisabledMode();
    gCities.selectAll("g.city").classed("pin-disabled", disablePins);
    gCities.selectAll("g.city").classed("pinned", isPinned);
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

  function getInteractionFocusKeys(){
    const focusKeys = new Set();
    if(_hoverCityKey) focusKeys.add(_hoverCityKey);
    for(const key of pinned.keys()) focusKeys.add(key);
    return focusKeys;
  }

  function markerPromotionCap(zoomK = 1){
    const k = Math.max(1, Number(zoomK) || 1);
    const match = MARKER_SYSTEM.promotionCapByZoom.find((r) => k <= r.maxK);
    return match ? match.cap : 12;
  }

  function buildUiAvoidZones(){
    const zones = [];
    if(mapHudEl){
      const hudWidth = mapHudEl.offsetWidth || 272;
      const hudHeight = mapHudEl.offsetHeight || 92;
      zones.push({
        x: Math.max(8, 24),
        y: Math.max(8, mapHeight - hudHeight - 24),
        w: Math.min(hudWidth + 12, mapWidth * 0.54),
        h: hudHeight + 10
      });
    }
    if(pinnedPanelEl && pinnedPanelEl.style.display !== "none"){
      const panelWidth = pinnedPanelEl.offsetWidth || 300;
      zones.push({ x: Math.max(0, mapWidth - panelWidth - 18), y: 8, w: Math.min(panelWidth + 16, mapWidth), h: mapHeight - 16 });
    }
    return zones;
  }

  function getViewportWorldBounds(zoomK = 1){
    const t = lastZoomTransform || d3.zoomIdentity;
    const k = Math.max(1, Number(zoomK) || Number(t.k) || 1);
    const x = Number.isFinite(t.x) ? t.x : 0;
    const y = Number.isFinite(t.y) ? t.y : 0;
    return {
      minX: (-x) / k,
      maxX: (mapWidth - x) / k,
      minY: (-y) / k,
      maxY: (mapHeight - y) / k
    };
  }

  function scorePromotedCities(cities, zoomK = 1, viewport = null){
    const points = cities.map((city) => ({ city, key: cityKey(city), x: city._xy[0], y: city._xy[1] }));
    const maxPop = Math.max(1, ...points.map((p) => Number(p.city.pop) || 1));
    const minPop = Math.min(...points.map((p) => Math.max(1, Number(p.city.pop) || 1)));
    const centerX = viewport ? (viewport.minX + viewport.maxX) / 2 : (mapWidth / 2);
    const centerY = viewport ? (viewport.minY + viewport.maxY) / 2 : (mapHeight / 2);
    const diag = Math.hypot(mapWidth, mapHeight) || 1;
    return points.map((p) => {
      const pop = Math.max(1, Number(p.city.pop) || 1);
      const popNorm = (Math.log(pop) - Math.log(minPop)) / Math.max(0.0001, (Math.log(maxPop) - Math.log(minPop)));
      let nearest = Infinity;
      for(const other of points){
        if(other.key === p.key) continue;
        const d = Math.hypot(other.x - p.x, other.y - p.y);
        if(d < nearest) nearest = d;
      }
      const spacingNorm = Math.max(0, Math.min(1, (nearest - 24) / 110));
      const centerBias = 1 - Math.min(1, Math.hypot(p.x - centerX, p.y - centerY) / diag);
      const zoomBias = Math.max(0, Math.min(1, (zoomK - 1) / 3));
      return {
        city: p.city,
        key: p.key,
        score: (popNorm * 0.58) + (spacingNorm * 0.28) + (centerBias * 0.08) + (zoomBias * 0.06)
      };
    }).sort((a, b) => b.score - a.score);
  }

  function buildPromotionSignature(zoomK, viewport, candidateKeys){
    const t = lastZoomTransform || d3.zoomIdentity;
    const zoomBucket = Math.round((Number(zoomK) || 1) * 20) / 20;
    const panXBucket = Math.round((Number(t.x) || 0) / 60);
    const panYBucket = Math.round((Number(t.y) || 0) / 60);
    const viewBucket = [
      Math.round(viewport.minX / 18),
      Math.round(viewport.maxX / 18),
      Math.round(viewport.minY / 18),
      Math.round(viewport.maxY / 18)
    ].join(":");
    return `z:${zoomBucket}|p:${panXBucket},${panYBucket}|v:${viewBucket}|k:${candidateKeys.join(",")}`;
  }

  function rectsOverlap(a, b, pad = 0){
    return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
  }

  function overlapArea(a, b){
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ix * iy;
  }

  function candidateRects(anchorX, anchorY, w, h, gap = 6){
    return [
      { pos: "top-right", x: anchorX + gap, y: anchorY - h - gap },
      { pos: "top-left", x: anchorX - w - gap, y: anchorY - h - gap },
      { pos: "right", x: anchorX + gap, y: anchorY - (h / 2) },
      { pos: "left", x: anchorX - w - gap, y: anchorY - (h / 2) },
      { pos: "bottom-right", x: anchorX + gap, y: anchorY + gap },
      { pos: "bottom-left", x: anchorX - w - gap, y: anchorY + gap },
      { pos: "top", x: anchorX - (w / 2), y: anchorY - h - gap },
      { pos: "bottom", x: anchorX - (w / 2), y: anchorY + gap }
    ];
  }

  function renderClusterMarkers(clusters){
    const clusterSel = gClusters.selectAll("g.cluster")
      .data(clusters, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "cluster");
          g.append("circle").attr("class", "cluster-hit").attr("r", 18);
          g.append("circle").attr("class", "cluster-dot").attr("r", CLUSTER_DOT_RADIUS);
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
  }

  function placePromotedMarkers(cities, scoredCandidates, focusPlan, zoomK = 1){
    const byKey = new Map();
    const focusSet = new Set();
    const promotedSet = new Set();
    const occupied = [];
    const uiZones = buildUiAvoidZones();
    const mapBounds = { x: 8, y: 8, w: Math.max(0, mapWidth - 16), h: Math.max(0, mapHeight - 16) };
    const candidateByKey = new Map(cities.map((c) => [cityKey(c), c]));
    const zoom = Math.max(1, Number(zoomK) || 1);

    function placeCity(city, tier, strict = true, focusKind = "pinned"){
      const key = cityKey(city);
      const [ax, ay] = city._xy;
      const spec = tier === "focus"
        ? (focusKind === "hover" ? MARKER_SYSTEM.hoverFocusBadge : MARKER_SYSTEM.focusBadge)
        : MARKER_SYSTEM.promotedBadge;
      const candidates = candidateRects(ax, ay, spec.w, spec.h, tier === "focus" ? 8 : 6);
      let best = null;
      let bestPenalty = Infinity;

      for(const c of candidates){
        const rect = { x: c.x, y: c.y, w: spec.w, h: spec.h, pos: c.pos };
        const outside = rect.x < mapBounds.x || rect.y < mapBounds.y || (rect.x + rect.w) > (mapBounds.x + mapBounds.w) || (rect.y + rect.h) > (mapBounds.y + mapBounds.h);
        const overlapExisting = occupied.some((o) => rectsOverlap(rect, o, spec.pad));
        const overlapUi = uiZones.some((z) => rectsOverlap(rect, z, 2));
        if(!outside && !overlapExisting && !overlapUi){
          best = rect;
          bestPenalty = 0;
          break;
        }
        if(!strict){
          let penalty = 0;
          if(outside){
            const xLeft = Math.max(0, mapBounds.x - rect.x);
            const xRight = Math.max(0, (rect.x + rect.w) - (mapBounds.x + mapBounds.w));
            const yTop = Math.max(0, mapBounds.y - rect.y);
            const yBottom = Math.max(0, (rect.y + rect.h) - (mapBounds.y + mapBounds.h));
            penalty += (xLeft + xRight + yTop + yBottom) * 12;
          }
          for(const o of occupied) penalty += overlapArea(rect, o) * 0.9;
          for(const z of uiZones) penalty += overlapArea(rect, z) * 0.6;
          if(penalty < bestPenalty){
            bestPenalty = penalty;
            best = rect;
          }
        }
      }
      if(!best) return false;
      occupied.push(best);
      byKey.set(key, {
        tier,
        pos: best.pos,
        offsetX: (best.x - ax) / zoom,
        offsetY: (best.y - ay) / zoom,
        invScale: 1 / zoom,
        width: spec.w,
        height: spec.h,
        focusKind
      });
      if(tier === "focus") focusSet.add(key); else promotedSet.add(key);
      return true;
    }

    const pinnedFocusPlan = focusPlan.filter((f) => f.kind !== "hover");
    const hoverFocusPlan = focusPlan.filter((f) => f.kind === "hover");

    for(const focusItem of pinnedFocusPlan){
      const city = candidateByKey.get(focusItem.key);
      if(Array.isArray(city?._xy)) placeCity(city, "focus", false, focusItem.kind);
    }

    const cap = markerPromotionCap(zoomK);
    for(const entry of scoredCandidates){
      if(promotedSet.size >= cap) break;
      const city = entry.city;
      const key = entry.key;
      if(focusSet.has(key) || !Array.isArray(city?._xy)) continue;
      const placed = placeCity(city, "promoted", true);
      if(!placed){
        byKey.set(key, { tier: "base" });
      }
    }

    for(const city of cities){
      const key = cityKey(city);
      if(!byKey.has(key)) byKey.set(key, { tier: "base" });
    }

    for(const focusItem of hoverFocusPlan){
      const city = candidateByKey.get(focusItem.key);
      if(Array.isArray(city?._xy)) placeCity(city, "focus", false, focusItem.kind);
    }

    return { byKey, promotedKeys: promotedSet, focusKeys: focusSet };
  }

  function computeMarkerStates(cities, zoomK = 1){
    const focusKeys = getInteractionFocusKeys();
    const hoverKey = _hoverCityKey || null;
    const pinnedKeys = new Set(Array.from(pinned.keys()));
    const focusPlan = [];
    for(const key of pinnedKeys){
      focusPlan.push({ key, kind: "pinned" });
    }
    if(hoverKey){
      focusPlan.push({ key: hoverKey, kind: "hover" });
    }
    const viewport = getViewportWorldBounds(zoomK);
    const viewportPad = 24 / Math.max(1, zoomK);
    const visible = cities.filter((city) => {
      const key = cityKey(city);
      if(!Array.isArray(city?._xy)) return false;
      const [x, y] = city._xy;
      const inView = x >= (viewport.minX - viewportPad) && x <= (viewport.maxX + viewportPad) && y >= (viewport.minY - viewportPad) && y <= (viewport.maxY + viewportPad);
      if(!inView && !focusKeys.has(key)) return false;
      if(clusterState.cityToCluster.has(key) && !focusKeys.has(key)) return false;
      return true;
    });
    const promotedPool = cities.filter((city) => {
      const key = cityKey(city);
      if(!Array.isArray(city?._xy)) return false;
      if(pinnedKeys.has(key)) return false;
      if(clusterState.cityToCluster.has(key)) return false;
      const [x, y] = city._xy;
      return x >= (viewport.minX - viewportPad) && x <= (viewport.maxX + viewportPad) && y >= (viewport.minY - viewportPad) && y <= (viewport.maxY + viewportPad);
    });
    const poolByKey = new Map(promotedPool.map((city) => [cityKey(city), city]));
    const candidateKeys = Array.from(poolByKey.keys()).sort();
    const signature = buildPromotionSignature(zoomK, viewport, candidateKeys);
    let scored;
    if(promotedSelectionCache.signature === signature){
      scored = promotedSelectionCache.orderedKeys
        .map((key) => poolByKey.get(key))
        .filter(Boolean)
        .map((city) => ({ city, key: cityKey(city), score: 0 }));
    } else {
      scored = scorePromotedCities(promotedPool, zoomK, viewport);
      promotedSelectionCache.signature = signature;
      promotedSelectionCache.orderedKeys = scored.map((s) => s.key);
    }
    const placed = placePromotedMarkers(visible, scored, focusPlan, zoomK);
    markerState = {
      zoomK,
      byKey: placed.byKey,
      promotedKeys: placed.promotedKeys,
      focusKeys: placed.focusKeys
    };
    return markerState;
  }

  function renderBaseMarkers(citySel, state){
    citySel
      .classed("is-clustered", (d) => clusterState.cityToCluster.has(cityKey(d)))
      .style("display", (d) => {
        const key = cityKey(d);
        if(clusterState.cityToCluster.has(key) && !state.focusKeys.has(key)) return "none";
        return null;
      });

    citySel.each(function(d){
      const key = cityKey(d);
      const tier = state.byKey.get(key)?.tier || "base";
      const sel = d3.select(this);
      sel.classed("marker-base", tier === "base")
        .classed("marker-promoted-city", tier === "promoted")
        .classed("marker-focus-city", tier === "focus");

      const radius = tier === "focus"
        ? MARKER_SYSTEM.focusRadius
        : (tier === "promoted" ? MARKER_SYSTEM.promotedRadius : MARKER_SYSTEM.baseRadius);
      sel.select("circle.city-dot").attr("r", radius);
      sel.select("circle.hover-ring").attr("r", radius * 1.03);
      sel.select("g.city-weather-icon")
        .style("display", tier === "base" ? null : "none")
        .style("opacity", tier === "base" ? 0.82 : 0);
    });
  }

  function renderPromotedMarkers(citySel, state){
    citySel.each(function(d){
      const key = cityKey(d);
      const marker = state.byKey.get(key);
      const promoted = d3.select(this).select("g.marker-promoted");
      if(!marker || marker.tier !== "promoted"){
        promoted.style("display", "none");
        return;
      }
      const snap = getSelectedWeatherSnapshot(d?._wx);
      const temp = (snap?.temp != null && isFinite(snap.temp)) ? `${Math.round(snap.temp)}°` : "—";
      const cond = wxCodeToIconLabel(snap?.code);
      promoted
        .style("display", null)
        .attr("transform", `translate(${marker.offsetX},${marker.offsetY}) scale(${marker.invScale})`)
        .attr("data-pos", marker.pos);
      promoted.select("text.promoted-temp").text(temp);
      promoted.select("text.promoted-icon").text(cond.icon || "");
    });
  }

  function renderFocusMarkers(citySel, state){
    citySel.each(function(d){
      const key = cityKey(d);
      const marker = state.byKey.get(key);
      const focus = d3.select(this).select("g.marker-focus");
      if(!marker || marker.tier !== "focus"){
        focus.style("display", "none");
        return;
      }
      const snap = getSelectedWeatherSnapshot(d?._wx);
      const temp = (snap?.temp != null && isFinite(snap.temp)) ? `${Math.round(snap.temp)}°` : "—";
      const cond = wxCodeToIconLabel(snap?.code);
      const isHover = marker.focusKind === "hover";
      focus
        .style("display", null)
        .classed("is-hover-focus", isHover)
        .classed("is-pinned-focus", !isHover)
        .attr("transform", `translate(${marker.offsetX},${marker.offsetY}) scale(${marker.invScale})`)
        .attr("data-pos", marker.pos);
      focus.select("rect.focus-badge")
        .attr("width", marker.width || MARKER_SYSTEM.focusBadge.w)
        .attr("height", marker.height || MARKER_SYSTEM.focusBadge.h);
      focus.select("text.focus-city")
        .style("display", isHover ? "none" : null)
        .text(isHover ? "" : `${d.city}, ${d.state}`);
      focus.select("text.focus-temp")
        .attr("x", 8)
        .attr("y", isHover ? 17 : 29);
      focus.select("text.focus-icon")
        .attr("x", (marker.width || MARKER_SYSTEM.focusBadge.w) - 12)
        .attr("y", isHover ? 17 : 29);
      focus.select("text.focus-temp").text(temp);
      focus.select("text.focus-icon").text(cond.icon || "");
    });
  }

  function applyMarkerZOrder(citySel, state){
    const rank = (d) => {
      const tier = state.byKey.get(cityKey(d))?.tier || "base";
      return tier === "focus" ? 2 : (tier === "promoted" ? 1 : 0);
    };
    citySel.sort((a, b) => d3.ascending(rank(a), rank(b)));
  }

  function refreshMarkerSystem(zoomK = 1){
    const citySel = gCities.selectAll("g.city");
    if(citySel.empty()) return;
    const state = computeMarkerStates(activeCities, zoomK);
    renderBaseMarkers(citySel, state);
    renderPromotedMarkers(citySel, state);
    renderFocusMarkers(citySel, state);
    applyMarkerZOrder(citySel, state);
  }

  function updateClusterLayout(zoomK = 1) {
    if (!gCities || !gClusters) return;
    clusterState.zoomK = zoomK;
    const built = buildCityClusters(zoomK);
    clusterState.clusters = built.clusters;
    clusterState.cityToCluster = built.cityToCluster;
    renderClusterMarkers(clusterState.clusters);
    refreshMarkerSystem(zoomK);
    if (_hoverCityKey && clusterState.cityToCluster.has(_hoverCityKey)) hideTooltip();
  }

  function togglePin(d){
    if(isPinningDisabledMode()){
      setStatus("Pin cards are disabled for Coldest Day mode (hover only).");
      return;
    }
    const k = cityKey(d);
    if(pinned.has(k)){
      pinned.delete(k);
      if(focusedKey === k) setActivePinnedKey(null, { syncFocus: false });
    } else {
      pinned.set(k, d);
      setActivePinnedKey(k, { syncFocus: false });
      ensureCensus(d);
      ensureAQI(d);
    }
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
    refreshMarkerSystem(lastZoomTransform?.k || 1);
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
    updateLegendContext(legendTagEl?.textContent || "Live");

    if (colorMode === "aqi") {
      bar.style.background = `linear-gradient(to right, #10b981 16%, #fbbf24 33%, #f97316 50%, #ef4444 66%, #a855f7 83%, #9f1239 100%)`;
      minEl.textContent = "0";
      maxEl.textContent = "300+";
      legend.style.display = "grid";
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
    minEl.textContent = `${Math.round(lastMinHigh)}${unit}`;
    maxEl.textContent = `${Math.round(lastMaxHigh)}${unit}`;
    legend.style.display = "grid";
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
          .style("pointer-events", "none");
        appendWeatherIconGlyph(g, "city-weather-icon");

        const promotedBadge = g.append("g").attr("class", "marker-promoted").style("display", "none");
        promotedBadge.append("rect").attr("class", "marker-badge promoted-badge").attr("rx", 7).attr("ry", 7).attr("width", MARKER_SYSTEM.promotedBadge.w).attr("height", MARKER_SYSTEM.promotedBadge.h);
        promotedBadge.append("text").attr("class", "promoted-temp").attr("x", 8).attr("y", 16);
        promotedBadge.append("text").attr("class", "promoted-icon").attr("x", MARKER_SYSTEM.promotedBadge.w - 12).attr("y", 16).attr("text-anchor", "middle");

        const focusBadge = g.append("g").attr("class", "marker-focus").style("display", "none");
        focusBadge.append("rect").attr("class", "marker-badge focus-badge").attr("rx", 9).attr("ry", 9).attr("width", MARKER_SYSTEM.focusBadge.w).attr("height", MARKER_SYSTEM.focusBadge.h);
        focusBadge.append("text").attr("class", "focus-city").attr("x", 8).attr("y", 13);
        focusBadge.append("text").attr("class", "focus-temp").attr("x", 8).attr("y", 29);
        focusBadge.append("text").attr("class", "focus-icon").attr("x", MARKER_SYSTEM.focusBadge.w - 12).attr("y", 29).attr("text-anchor", "middle");

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
    let done = 0; let failed = 0; let cacheHits = 0;
    let historicalLimitReached = false;

    for (const c of activeCities) {
      c._wxError = false; c._pulsed = false;
      const cached = readCache(c);
      if (cached) { c._wx = cached.payload; c._wxMeta = { source: "cache", fetchedAt: cached.fetchedAt }; cacheHits += 1; } 
      else { c._wx = undefined; c._wxMeta = { source: "none", fetchedAt: null }; }
    }

    computeScaleFromLoaded(false); applyDotColors(false); if (pinned.size > 0) renderPinnedPanel();
    setProgress(0, activeCities.length, 0);
    setStatus(cacheHits > 0 ? "Using cached data" : "Loading data…", {
      type: "loading",
      persist: true,
      showProgress: true
    });

    const poolSize = isHistoricalMode ? CONCURRENCY_HIST : CONCURRENCY;
    await asyncPool(poolSize, activeCities, async (city) => {
      const needsNet = force || shouldRefreshFromNetwork(city);
      if (isHistoricalMode && historicalLimitReached) {
        if (!(city._wx && city._wxMeta?.source === "cache")) {
          city._wx = null;
          city._wxError = true;
          city._wxMeta = { source: "none", fetchedAt: null };
          failed += 1;
        }
        done += 1;
        setProgress(done, activeCities.length, failed);
        return;
      }
      if (needsNet) {
        try {
          const wx = await fetchWeatherNetwork(city); const fetchedAt = Date.now();
          city._wx = wx; city._wxError = false; city._wxMeta = { source: "live", fetchedAt };
          writeCache(city, wx, fetchedAt);
          if (!city._pulsed) { city._pulsed = true; pulseDotOnce(city); }
          refreshTooltipIfHovering(city);
        } catch (err) {
          console.error(`[weather-fetch] ${city.city}, ${city.state} failed`, err);
          if (isHistoricalMode && isProviderDailyLimitError(err)) {
            historicalLimitReached = true;
            lockTimeMachineUntilTomorrow();
            applyTimeMachineAvailability();
            setStatus(`Historical unavailable`, { type: "warning", persist: true, duration: 5200 });
          }
          if (!(city._wx && city._wxMeta?.source === "cache")) { city._wx = null; city._wxError = true; city._wxMeta = { source: "none", fetchedAt: null }; failed += 1; }
        }
      }
      computeScaleFromLoaded(true); if (pinned.size > 0) renderPinnedPanel();
      done += 1; setProgress(done, activeCities.length, failed);
    });

    const ok = activeCities.length - failed;
    if (isHistoricalMode && historicalLimitReached) {
      setStatus(`Historical unavailable`, { type: "warning", duration: 5200 });
    } else if (failed > 0) {
      setStatus(`Partial results loaded`, { type: "warning" });
    } else {
      setStatus(`Updated ${ok} cities`, { type: "success" });
    }
    
    // Default timeline to current local hour (rounded) in live mode.
    if (selectedHourIndex === 0 && !isHistoricalMode) {
      const sample = activeCities.find(c => c._wx?.hourly?.time);
      if (sample) {
        const idx = findTimelineIndexForCurrentHour(sample._wx.hourly.time);
        selectedHourIndex = Math.max(0, Math.min(71, idx));
        if (daySlider) daySlider.value = String(selectedHourIndex);
        updateDayLabelUI();
      }
    }

    computeScaleFromLoaded(false); applyDotColors(false);
    requestAnimationFrame(() => { computeScaleFromLoaded(false); applyDotColors(false); });
    updateDayLabelUI();
    renderPinnedPanel();
  }

  async function main() {
    try {
      await fetchTopCitiesCatalog();
      loadSavedUserLocation();
      await fetchMemories();
      await fetchColdestDays();
      fetchSportsSchedules().catch((e) => console.error(e));
      setStatus("Loading map…", { type: "loading", persist: true });
      const us = await loadUSAtlasStates(); cachedUSMap = us; render(us);
      setStatus("Loading data…", { type: "loading", persist: true, showProgress: true });
      await loadAllWeather();
      computeScaleFromLoaded(false); applyDotColors(false);
    } catch (e) { setStatus("Map unavailable", { type: "error", persist: true, duration: 5200 }); }
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

  if(returnLiveBtn){
    returnLiveBtn.addEventListener("click", () => {
      if (isPlaying) {
        isPlaying = false;
        if(playBtn) playBtn.textContent = "▶️";
        clearInterval(playInterval);
      }
      jumpToLiveHour();
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
      const removeBtn = e.target.closest("button.pinRailRemove, button.pinInspectorRemove");
      if(removeBtn){
        const k = removeBtn.getAttribute("data-key"); if(!k) return;
        pinned.delete(k);
        if(focusedKey === k) setActivePinnedKey(null, { syncFocus: false });
        savePinned(); renderPinnedPanel(); updatePinnedStyles(); applyFocusStyles(); schedulePermalinkUpdate();
        return;
      }
      const selectBtn = e.target.closest("button.pinRailSelect");
      if(selectBtn){
        const k = selectBtn.getAttribute("data-key"); if(!k || !pinned.has(k)) return;
        setActivePinnedKey(k, { syncFocus: false });
        renderPinnedPanel(); applyFocusStyles(); schedulePermalinkUpdate();
        return;
      }
      const tabBtn = e.target.closest("button.pinSegmentBtn");
      if(tabBtn){
        const tab = tabBtn.getAttribute("data-tab");
        if(!tab || pinnedPanelTab === tab) return;
        pinnedPanelTab = tab;
        renderPinnedPanel();
      }
    });
  }

  svg.on("click", () => hideTooltip());
  window.addEventListener("resize", debounce(async () => { try { const us = await loadUSAtlasStates(); cachedUSMap = us; render(us); } catch {} }));

  initHistoricalDateInput();
  applyTimeMachineAvailability();
  setAQIOptionEnabled(true);
  if(tmDateWrap) tmDateWrap.hidden = !isHistoricalMode;
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
  document.addEventListener("visibilitychange", () => {
    if(document.hidden){
      if(isUpsideDownMode) pauseThemeAudio("upside");
      if(isSpookyMode) pauseThemeAudio("spooky");
      return;
    }
    if(isUpsideDownMode && themeAudioState.upside.isEnabled && !themeAudioState.upside.isMuted){
      playThemeAudio("upside", { userInitiated: false, forceEnable: true }).catch(() => {});
    } else {
      renderThemeAudioControls("upside");
    }
    if(isSpookyMode && themeAudioState.spooky.isEnabled && !themeAudioState.spooky.isMuted){
      playThemeAudio("spooky", { userInitiated: false, forceEnable: true }).catch(() => {});
    } else {
      renderThemeAudioControls("spooky");
    }
  });
  populateMemoryCityOptions();
  if(memoryDateInput){
    memoryDateInput.value = isoDate(new Date());
    memoryDateInput.max = getHistoricalStartMaxISO();
  }
  setMemoryFormVisible(false);
  setMemoryJournalVisible(false);
  setAddCityModalVisible(false);
  for(const themeKey of Object.keys(THEME_AUDIO_CONFIG)){
    const cfg = THEME_AUDIO_CONFIG[themeKey];
    const state = themeAudioState[themeKey];
    state.isMuted = readBoolLS(cfg.mutedKey, false);
    state.isEnabled = readBoolLS(cfg.enabledKey, false);
    initThemeAudio(themeKey);
    renderThemeAudioControls(themeKey);
  }

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




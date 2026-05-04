const API_BASE_URL = "http://localhost:8000/api";
const osmSource = new ol.source.OSM();

const state = {
  activeTab: "netatmo",
  netatmo: {
    day: null,
    month: 1,
    year: 2021,
    hour: null,
    dataVal: null,
    locked: false,
    manualResolution: 5,
    showStations: true,
    showHex: true,
    includeSensorCommunity: false,
  },
  sensor: {
    day: null,
    month: 1,
    year: 2025,
    hour: null,
    locked: false,
    manualResolution: 5,
    showStations: true,
    showHex: true,
    includeNetatmo: false,
  },
};

let currentZoom = 9;
let zoomUpdateTimeout = null;
let previouslySelectedFeature = null;
let stationsCache = null;
let sensorStationsCache = null;

const tabBtnNetatmo = document.getElementById("tabBtnNetatmo");
const tabBtnSensor = document.getElementById("tabBtnSensor");
const panelNetatmo = document.getElementById("panel-netatmo");
const panelSensor = document.getElementById("panel-sensor");

const netatmoMonthSelect = document.getElementById("netatmoMonthSelect");
const netatmoDataValSelect = document.getElementById("netatmoDataValSelect");
const netatmoLockResolution = document.getElementById("netatmoLockResolution");
const netatmoResolutionSelect = document.getElementById("netatmoResolutionSelect");
const netatmoToggleStations = document.getElementById("netatmoToggleStations");
const netatmoToggleHex = document.getElementById("netatmoToggleHex");
const netatmoIncludeSensor = document.getElementById("netatmoIncludeSensor");
const netatmoUpdateBtn = document.getElementById("netatmoUpdateBtn");

const sensorLockResolution = document.getElementById("sensorLockResolution");
const sensorResolutionSelect = document.getElementById("sensorResolutionSelect");
const sensorToggleHex = document.getElementById("sensorToggleHex");
const sensorIncludeNetatmo = document.getElementById("sensorIncludeNetatmo");
const sensorUpdateBtn = document.getElementById("sensorUpdateBtn");

const sensorDaySelect = document.getElementById("sensorDaySelect");
const sensorMonthSelect = document.getElementById("sensorMonthSelect");
const sensorYearInput = document.getElementById("sensorYearInput");
const sensorHourSelect = document.getElementById("sensorHourSelect");

const netatmoLegend = document.getElementById("netatmoLegend");
const sensorLegend = document.getElementById("sensorLegend");
const sensorToggleStations = document.getElementById("sensorToggleStations");

const container = document.getElementById("popup");
const content = document.getElementById("popup-content");
const closer = document.getElementById("popup-closer");

const netatmoDaySelect = document.getElementById("netatmoDaySelect");
const netatmoYearInput = document.getElementById("netatmoYearInput");
const netatmoHourSelect = document.getElementById("netatmoHourSelect");

const hexGeometryCache = new Map();
const hexStyleCache = new Map();

const NEGATIVE_TEMP_PALETTE = [
  [33, 102, 172],    
  [67, 147, 195],
  [146, 197, 222],
  [209, 229, 240],  
];

const POSITIVE_TEMP_PALETTE = [
  [253, 219, 199],   
  [244, 165, 130],
  [214, 96, 77],
  [178, 24, 43],    
];

const ZERO_TEMP_COLOR = [245, 245, 245];

function interpolateColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

function getColorFromPalette(palette, t) {
  const safeT = Math.max(0, Math.min(1, t));

  if (palette.length === 1) {
    return palette[0];
  }

  const scaled = safeT * (palette.length - 1);
  const left = Math.floor(scaled);
  const right = Math.min(left + 1, palette.length - 1);
  const localT = scaled - left;

  return interpolateColor(palette[left], palette[right], localT);
}

function getColorForTemperatureBin(min, max, domainMin, domainMax) {
  const mid = (min + max) / 2;

  if (max <= 0) {
    const coldMin = Math.min(domainMin, -0.1);
    const t = (mid - coldMin) / (0 - coldMin);

    return getColorFromPalette(NEGATIVE_TEMP_PALETTE, t);
  }

  if (min >= 0) {
    const warmMax = Math.max(domainMax, 0.1);
    const t = mid / warmMax;

    return getColorFromPalette(POSITIVE_TEMP_PALETTE, t);
  }

  return ZERO_TEMP_COLOR;
}

function roundDown(value, step) {
  return Math.floor(value / step) * step;
}

function roundUp(value, step) {
  return Math.ceil(value / step) * step;
}

function formatTemp(value) {
  if (!Number.isFinite(value)) return "";

  const rounded = Math.round(value * 10) / 10;

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return String(rounded).replace(".", ",");
}

function getStepByResolution(resolution) {
  if (resolution >= 8) return 1.5;
  if (resolution >= 6) return 3;
  if (resolution >= 6) return 5;
  return 10;
}

function isColdMonth(month) {
  return [11, 12, 1, 2, 3].includes(Number(month));
}

function isWarmMonth(month) {
  return [5, 6, 7, 8, 9].includes(Number(month));
}

function getTemperaturesFromGeojsonList(geojsonList) {
  const temps = [];

  for (const geojson of geojsonList) {
    if (!geojson || !Array.isArray(geojson.features)) continue;

    for (const feature of geojson.features) {
      const value = Number(feature?.properties?.avg_temperature);

      if (Number.isFinite(value)) {
        temps.push(value);
      }
    }
  }

  return temps;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;

  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;

  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }

  return sortedValues[base];
}

function buildTemperatureScale(geojsonList, month, resolution) {
  const temps = getTemperaturesFromGeojsonList(geojsonList).sort((a, b) => a - b);

  if (!temps.length) {
    return activeTemperatureScale;
  }

  const step = getStepByResolution(resolution);

  const q05 = quantile(temps, 0.05);
  const q95 = quantile(temps, 0.95);

  let minValue = q05 - step;
  let maxValue = q95 + step;

  if (isColdMonth(month)) {
    if (q95 <= 0) {
      maxValue = 0;
    } else if (q95 <= 5) {
      maxValue = 0;
    }
  }
  if (isWarmMonth(month) && q05 >= 0) {
    minValue = 0;
  }

  let domainMin = roundDown(minValue, step);
  let domainMax = roundUp(maxValue, step);

  if (domainMin === domainMax) {
    domainMin -= step;
    domainMax += step;
  }

  const bins = [];

  for (let start = domainMin; start < domainMax; start += step) {
    const end = start + step;

    bins.push({
      min: start,
      max: end,
      label: `${formatTemp(start)} – ${formatTemp(end)}`,
      color: getColorForTemperatureBin(start, end, domainMin, domainMax),
    });
  }

  return {
    id: `${domainMin}_${domainMax}_${step}_${month}_${resolution}`,
    bins,
  };
}

function getColorByTemperature(temp) {
  const value = Number(temp);
  const bins = activeTemperatureScale.bins;

  if (!Number.isFinite(value)) {
    return [160, 160, 160];
  }

  if (value < bins[0].min) {
    return bins[0].color;
  }

  for (const bin of bins) {
    if (value >= bin.min && value < bin.max) {
      return bin.color;
    }
  }

  return bins[bins.length - 1].color;
}

function renderLegend(container, scale = activeTemperatureScale) {
  if (!container) return;

  const reversedBins = [...scale.bins].reverse();

  container.innerHTML = reversedBins.map(bin => {
    const color = bin.color;

    return `
      <div class="legend-item">
        <span class="legend-color" style="background: rgb(${color.join(",")});"></span>
        <span>${bin.label}</span>
      </div>
    `;
  }).join("");
}

function updateTemperatureScale(geojsonList, month, resolution, legendContainer) {
  activeTemperatureScale = buildTemperatureScale(geojsonList, month, resolution);

  hexStyleCache.clear();

  renderLegend(legendContainer, activeTemperatureScale);
}

function getResolutionFromZoom(zoom) {
  const zoomToResolution = {
    6: 4,
    7: 4,
    8: 5,
    9: 6,
    10: 7,
    11: 7,
    12: 8,
    13: 8,
    14: 9,
    15: 9,  
  };

  for (let z = zoom; z >= 6; z--) {
    if (zoomToResolution[z] !== undefined) {
      return zoomToResolution[z];
    }
  }
  return 5;
}

function getTabResolution(tabName) {
  const cfg = state[tabName];
  if (cfg.locked) return cfg.manualResolution;
  return getResolutionFromZoom(Math.round(map.getView().getZoom()));
}

function getHexStyle(temp, selected = false, secondary = false, source = "netatmo") {
  const color = getColorByTemperature(temp);
  const key = `${activeTemperatureScale.id}_${source}_${color.join(",")}_${selected}_${secondary}`;

  if (hexStyleCache.has(key)) {
    return hexStyleCache.get(key);
  }

  const fillOpacity = selected ? 0.75 : secondary ? 0.22 : 0.5;
  const strokeOpacity = secondary ? 0.5 : 0.9;
  const strokeColor = selected
    ? "#d90d0dff"
    : source === "sensor" && secondary
      ? `rgba(${color.join(",")},${strokeOpacity})`
      : `rgba(${color.join(",")},${strokeOpacity})`;

  const style = new ol.style.Style({
    stroke: new ol.style.Stroke({
      color: strokeColor,
      width: selected ? 1.5 : 1,
      lineDash: secondary ? [5, 3] : undefined,
    }),
    fill: new ol.style.Fill({
      color: `rgba(${color.join(",")},${fillOpacity})`,
    }),
  });

  hexStyleCache.set(key, style);
  return style;
}

function getHexGeometry(hexId) {
  if (hexGeometryCache.has(hexId)) {
    return hexGeometryCache.get(hexId).clone();
  }

  const boundary = h3.cellToBoundary(hexId);
  const boundaryLonLat = boundary.map(coord => [coord[1], coord[0]]);
  boundaryLonLat.push(boundaryLonLat[0]);

  const polygon = new ol.geom.Polygon([boundaryLonLat]);
  polygon.transform("EPSG:4326", "EPSG:3857");

  hexGeometryCache.set(hexId, polygon.clone());
  return polygon;
}

async function loadStations(forceReload = false) {
  if (stationsCache && !forceReload) return stationsCache;

  try {
    const response = await fetch(`${API_BASE_URL}/stations/`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const geojson = await response.json();
    stationsCache = geojson;
    return geojson;
  } catch (error) {
    console.error("Ошибка при загрузке станций:", error);
    return { type: "FeatureCollection", features: [] };
  }
}

async function loadH3Aggregation(day = null, month = 1, year = null, hour = null, resolution = 5, data_val = null) {
  try {
    const requestBody = {
      month,
      year,
      resolution,
    };

    if (data_val) {
      requestBody.data_val = parseInt(data_val, 10);
    }

    const useDateAggregation = day !== null && day !== "" && day !== undefined;

    if (useDateAggregation) {
      requestBody.day = parseInt(day, 10);

      if (hour !== null && hour !== "" && hour !== undefined) {
        requestBody.hour = parseInt(hour, 10);
      }
    }

    const endpoint = useDateAggregation
      ? `${API_BASE_URL}/h3-date-aggregation/`
      : `${API_BASE_URL}/h3-aggregation/`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let backendMessage = "";
      try {
        const errorData = await response.json();
        backendMessage = errorData?.error || errorData?.detail || "";
      } catch (_) {}

      throw new Error(
        backendMessage
          ? `HTTP error! status: ${response.status}. ${backendMessage}`
          : `HTTP error! status: ${response.status}`
      );
    }

    return await response.json();
  } catch (error) {
    console.error("Ошибка при загрузке H3 агрегации:", error);
    return { type: "FeatureCollection", features: [] };
  }
}

async function loadSensorStations(forceReload = false) {
  if (sensorStationsCache && !forceReload) return sensorStationsCache;

  try {
    const response = await fetch(`${API_BASE_URL}/sensor-stations/`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const geojson = await response.json();
    sensorStationsCache = geojson;
    return geojson;

  } catch (error) {
    console.error("Ошибка при загрузке станций sensor.community:", error);
    return { type: "FeatureCollection", features: [] };
  }
}


async function loadSensorH3Aggregation(
  day = null,
  month = 1,
  year = 2025,
  hour = null,
  resolution = 5
) {
  try {
    const requestBody = {
      year,
      resolution,
    };

    if (month !== null && month !== "" && month !== undefined) {
      requestBody.month = parseInt(month, 10);
    }

    if (day !== null && day !== "" && day !== undefined) {
      requestBody.day = parseInt(day, 10);

      if (hour !== null && hour !== "" && hour !== undefined) {
        requestBody.hour = parseInt(hour, 10);
      }
    }

    const response = await fetch(`${API_BASE_URL}/sensor-stations-h3-aggregation/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let backendMessage = "";

      try {
        const errorData = await response.json();
        backendMessage = errorData?.error || errorData?.detail || "";
      } catch (_) {}

      throw new Error(
        backendMessage
          ? `HTTP error! status: ${response.status}. ${backendMessage}`
          : `HTTP error! status: ${response.status}`
      );
    }

    return await response.json();

  } catch (error) {
    console.error("Ошибка при загрузке H3 агрегации sensor.community:", error);
    return { type: "FeatureCollection", features: [] };
  }
}

const baseLayer = new ol.layer.Tile({ 
    source: osmSource,
    title: "Базовая карта",
    type: "base",
 });

const stationSource = new ol.source.Vector();
const netatmoHexSource = new ol.source.Vector();
const sensorHexSource = new ol.source.Vector();
const sensorStationSource = new ol.source.Vector();

const stationLayer = new ol.layer.Vector({
  source: stationSource,
  title: "Станции Netatmo",
  style: new ol.style.Style({
    image: new ol.style.Circle({
      radius: 4,
      fill: new ol.style.Fill({ color: "red" }),
      stroke: new ol.style.Stroke({ color: "#fff", width: 1 }),
    }),
  }),
});

const sensorStationLayer = new ol.layer.Vector({
  source: sensorStationSource,
  title: "Станции sensor.community",
  style: new ol.style.Style({
    image: new ol.style.Circle({
      radius: 4,
      fill: new ol.style.Fill({ color: "#2563eb" }),
      stroke: new ol.style.Stroke({ color: "#ffffff", width: 1 }),
    }),
  }),
});

const netatmoHexLayer = new ol.layer.Vector({ 
    source: netatmoHexSource,
    title: "Сетка Netatmo", 
});
const sensorHexLayer = new ol.layer.Vector({ 
    source: sensorHexSource,
    title: "Сетка sensor.community", 
});

netatmoHexLayer.setZIndex(5);
sensorHexLayer.setZIndex(6);
stationLayer.setZIndex(10);
sensorStationLayer.setZIndex(11);

const map = new ol.Map({
  target: "map",
  layers: [baseLayer, netatmoHexLayer, sensorHexLayer, stationLayer, sensorStationLayer],
  view: new ol.View({
    center: ol.proj.fromLonLat([37.62, 55.75]),
    zoom: 9,
    projection: "EPSG:3857",
  }),
});

const layerSwitcher = new ol.control.LayerSwitcher({
  activationMode: "click",
  startActive: false,
  tipLabel: "Слои",
  groupSelectStyle: "none",
});

map.addControl(layerSwitcher);

function updateNetatmoHourState() {
  const hasSpecificDay = state.netatmo.day !== null && state.netatmo.day !== "";
  netatmoHourSelect.disabled = !hasSpecificDay;

  if (!hasSpecificDay) {
    netatmoHourSelect.value = "";
    state.netatmo.hour = null;
  }
}

function addStationsToSource(geojsonData, source) {
  source.clear();

  const format = new ol.format.GeoJSON();
  const features = format.readFeatures(geojsonData, {
    featureProjection: "EPSG:3857",
  });

  for (const feature of features) {
    const properties = feature.getProperties();
    feature.set("id", properties.device_id);
    source.addFeature(feature);
  }
}

function addHexagonsToSource(geojsonData, targetSource, options = {}) {
  const { sourceName = "netatmo", secondary = false } = options;
  targetSource.clear();

  for (const feature of geojsonData.features) {
    const hexId = feature.properties.hex_id;
    const temp = feature.properties.avg_temperature;
    const count = feature.properties.count;

    if (!hexId) continue;

    const polygon = getHexGeometry(hexId);
    const olFeature = new ol.Feature({
      geometry: polygon,
      temperature: temp,
      count: count,
      hex_id: hexId,
      sourceName,
      secondary,
    });

    olFeature.setStyle(getHexStyle(temp, false, secondary, sourceName));
    targetSource.addFeature(olFeature);
  }
}

function addSensorStationsToSource(geojsonData, source) {
  source.clear();

  const format = new ol.format.GeoJSON();
  const features = format.readFeatures(geojsonData, {
    featureProjection: "EPSG:3857",
  });

  for (const feature of features) {
    const properties = feature.getProperties();

    feature.set("sensor_id", properties.sensor_id);
    feature.set("location_id", properties.location_id ?? null);
    feature.set("station_temperature", properties.temperature ?? null);
    feature.set("station_source", "sensor");

    source.addFeature(feature);
  }
}

function updateSensorHourState() {
  const hasSpecificDay = state.sensor.day !== null && state.sensor.day !== "";
  sensorHourSelect.disabled = !hasSpecificDay;

  if (!hasSpecificDay) {
    sensorHourSelect.value = "";
    state.sensor.hour = null;
  }
}

function validateSensorYear() {
  const yearValue = String(sensorYearInput.value).trim();

  if (!yearValue) {
    sensorYearInput.classList.add("invalid");
    alert("Для данных sensor.community нужно указать год.");
    return false;
  }

  sensorYearInput.classList.remove("invalid");
  return true;
}

function clearAllLayers() {
  stationSource.clear();
  netatmoHexSource.clear();
  sensorHexSource.clear();
  sensorStationSource.clear();
}

async function renderNetatmoTab() {
  hideMapMessage();
  const cfg = state.netatmo;
  const resolution = getTabResolution("netatmo");

  const requests = [];

  if (cfg.showStations) {
    requests.push(loadStations());
  }

  requests.push(
    loadH3Aggregation(
      cfg.day,
      cfg.month,
      cfg.year,
      cfg.hour,
      resolution,
      cfg.dataVal
    )
  );

  if (cfg.includeSensorCommunity) {
    requests.push(
      loadSensorH3Aggregation(
        state.netatmo.day,
        state.netatmo.month,
        state.netatmo.year,
        state.netatmo.hour,
        resolution
      )
    );

    requests.push(loadSensorStations());
  }

  const results = await Promise.all(requests);

  clearAllLayers();

  let idx = 0;

  if (cfg.showStations) {
    addStationsToSource(results[idx], stationSource);
    idx += 1;
  }

  const netatmoGeojson = results[idx];

  if (!netatmoGeojson.features || netatmoGeojson.features.length === 0) {
    clearAllLayers();
    stationLayer.setVisible(false);
    netatmoHexLayer.setVisible(false);
    sensorHexLayer.setVisible(false);
    sensorStationLayer.setVisible(false);
    showMapMessage("Измените временной промежуток");
    return;
  }

  const geojsonsForScale = [netatmoGeojson];

  if (cfg.includeSensorCommunity) {
    const sensorHexGeojsonForScale = results[idx + 1];

    if (
      sensorHexGeojsonForScale &&
      Array.isArray(sensorHexGeojsonForScale.features) &&
      sensorHexGeojsonForScale.features.length > 0
    ) {
      geojsonsForScale.push(sensorHexGeojsonForScale);
    }
  }

  updateTemperatureScale(geojsonsForScale, cfg.month, resolution, netatmoLegend);

  addHexagonsToSource(netatmoGeojson, netatmoHexSource, {
    sourceName: "netatmo",
    secondary: false,
  });
  idx += 1;

  if (cfg.includeSensorCommunity) {
    const sensorHexGeojson = results[idx];
    idx += 1;

    const sensorStationsGeojson = results[idx];
    idx += 1;

    addHexagonsToSource(sensorHexGeojson, sensorHexSource, {
      sourceName: "sensor",
      secondary: true,
    });

    addSensorStationsToSource(sensorStationsGeojson, sensorStationSource);
  }


  stationLayer.setVisible(cfg.showStations);
  netatmoHexLayer.setVisible(cfg.showHex);
  sensorHexLayer.setVisible(cfg.includeSensorCommunity);
  sensorStationLayer.setVisible(cfg.includeSensorCommunity);
}

async function renderSensorTab() {
  hideMapMessage();

  const cfg = state.sensor;
  const resolution = getTabResolution("sensor");

  if (!validateSensorYear()) return;

  if (cfg.includeNetatmo && !state.netatmo.year) {
    netatmoYearInput.classList.add("invalid");
    alert("Чтобы подключить Netatmo, сначала укажите год на вкладке Netatmo.");
    return;
  }

  const requests = [
    loadSensorH3Aggregation(
      cfg.day,
      cfg.month,
      cfg.year,
      cfg.hour,
      resolution
    )
  ];

  if (cfg.showStations) {
    requests.push(loadSensorStations());
  }

  if (cfg.includeNetatmo) {
    requests.push(
      loadH3Aggregation(
        state.sensor.day,
        state.sensor.month,
        state.sensor.year,
        state.sensor.hour,
        resolution,
        state.netatmo.dataVal
      )
    );

    requests.push(loadStations());
  }

  const results = await Promise.all(requests);

  clearAllLayers();

  let idx = 0;

  const sensorGeojson = results[idx];
  idx += 1;

  if (!sensorGeojson.features || sensorGeojson.features.length === 0) {
    clearAllLayers();
    sensorHexLayer.setVisible(false);
    sensorStationLayer.setVisible(false);
    netatmoHexLayer.setVisible(false);
    stationLayer.setVisible(false);
    showMapMessage("Измените временной промежуток");
    return;
  }

  const geojsonsForScale = [sensorGeojson];

  if (cfg.includeNetatmo) {
    const netatmoHexGeojsonForScale = cfg.showStations
      ? results[idx + 1]
      : results[idx];

    if (
      netatmoHexGeojsonForScale &&
      Array.isArray(netatmoHexGeojsonForScale.features) &&
      netatmoHexGeojsonForScale.features.length > 0
    ) {
      geojsonsForScale.push(netatmoHexGeojsonForScale);
    }
  }

  updateTemperatureScale(geojsonsForScale, cfg.month, resolution, sensorLegend);

  addHexagonsToSource(sensorGeojson, sensorHexSource, {
    sourceName: "sensor",
    secondary: false,
  });

  if (cfg.showStations) {
    const sensorStationsGeojson = results[idx];
    idx += 1;

    addSensorStationsToSource(sensorStationsGeojson, sensorStationSource);
  }

  if (cfg.includeNetatmo) {
    const netatmoHexGeojson = results[idx];
    idx += 1;

    const netatmoStationsGeojson = results[idx];
    idx += 1;

    addHexagonsToSource(netatmoHexGeojson, netatmoHexSource, {
      sourceName: "netatmo",
      secondary: true,
    });

    addStationsToSource(netatmoStationsGeojson, stationSource);
  }

  sensorHexLayer.setVisible(cfg.showHex);
  sensorStationLayer.setVisible(cfg.showStations);

  netatmoHexLayer.setVisible(cfg.includeNetatmo);
  stationLayer.setVisible(cfg.includeNetatmo);
}

async function renderActiveTab() {
  if (state.activeTab === "netatmo") {
    await renderNetatmoTab();
  } else {
    await renderSensorTab();
  }
}

function activateTab(tabName) {
  state.activeTab = tabName;

  tabBtnNetatmo.classList.toggle("active", tabName === "netatmo");
  tabBtnSensor.classList.toggle("active", tabName === "sensor");

  panelNetatmo.classList.toggle("active", tabName === "netatmo");
  panelSensor.classList.toggle("active", tabName === "sensor");

  renderActiveTab();
}

function resetPreviousSelection() {
  if (!previouslySelectedFeature) return;

  const prevTemp = previouslySelectedFeature.get("temperature");
  const prevSecondary = previouslySelectedFeature.get("secondary") === true;
  const prevSourceName = previouslySelectedFeature.get("sourceName") || "netatmo";

  previouslySelectedFeature.setStyle(
    getHexStyle(prevTemp, false, prevSecondary, prevSourceName)
  );
  previouslySelectedFeature = null;
}

const overlay = new ol.Overlay({
  element: container,
  autoPan: {
    animation: {
      duration: 250,
    },
  },
});
map.addOverlay(overlay);

closer.onclick = function () {
  overlay.setPosition(undefined);
  closer.blur();
  return false;
};

function validateNetatmoYear() {
  const yearValue = netatmoYearInput.value.trim();

  if (!yearValue) {
    netatmoYearInput.classList.add("invalid");
    alert("Для данных Netatmo нужно указать год.");
    return false;
  }

  netatmoYearInput.classList.remove("invalid");
  return true;
}

map.on("singleclick", function (evt) {
  const feature = map.forEachFeatureAtPixel(evt.pixel, feat => feat);

  resetPreviousSelection();

  if (!feature) {
    overlay.setPosition(undefined);
    return;
  }

  const geometry = feature.getGeometry();
  const coord =
    geometry.getType() === "Polygon"
      ? geometry.getInteriorPoint().getCoordinates()
      : geometry.getCoordinates();

    if (feature.get("id")) {
      const id = feature.get("id");
      content.innerHTML = `
        <b>Источник:</b> Netatmo<br>
        <b>id станции:</b> ${id}
      `;
      overlay.setPosition(coord);
      return;
    }

    if (feature.get("station_source") === "sensor") {
      const sensorId = feature.get("sensor_id");
      const locationId = feature.get("location_id");
      const temperature = feature.get("station_temperature");

      const locationLine =
        locationId !== undefined && locationId !== null
          ? `<b>location_id:</b> ${locationId}<br>`
          : "";

      const temperatureLine =
        temperature !== undefined && temperature !== null
          ? `<b>Температура:</b> ${Number(temperature).toFixed(2)} °C<br>`
          : "";

      content.innerHTML = `
        <b>Источник:</b> sensor.community<br>
        <b>sensor_id:</b> ${sensorId}<br>
        ${locationLine}
        ${temperatureLine}
      `;

      overlay.setPosition(coord);
      return;
    }

  if (feature.get("temperature") !== undefined) {
    const t = feature.get("temperature").toFixed(2);
    const count = feature.get("count") || 0;
    const sourceName = feature.get("sourceName") === "sensor" ? "sensor.community" : "Netatmo";

    content.innerHTML = `
      <b>Источник:</b> ${sourceName}<br>
      <b>Средняя температура:</b> ${t} °C<br>
      <b>Количество измерений:</b> ${count}<br>`;

    const temp = feature.get("temperature");
    const secondary = feature.get("secondary") === true;
    const srcName = feature.get("sourceName") || "netatmo";

    feature.setStyle(getHexStyle(temp, true, secondary, srcName));
    previouslySelectedFeature = feature;
    overlay.setPosition(coord);
  }
});

map.getView().on("change:resolution", function () {
  const newZoom = Math.round(map.getView().getZoom());
  if (Math.abs(newZoom - currentZoom) < 0.5) return;

  currentZoom = newZoom;

  clearTimeout(zoomUpdateTimeout);
  zoomUpdateTimeout = setTimeout(() => {
    const tabState = state[state.activeTab];
    if (tabState.locked) return;

    renderActiveTab();
  }, 400);
});

function syncNetatmoUiFromState() {
  netatmoDaySelect.value = state.netatmo.day ?? "";
  netatmoMonthSelect.value = String(state.netatmo.month);
  netatmoYearInput.value = state.netatmo.year ?? "";
  netatmoHourSelect.value = state.netatmo.hour ?? "";
  netatmoDataValSelect.value = state.netatmo.dataVal ?? "";
  netatmoLockResolution.checked = state.netatmo.locked;
  netatmoResolutionSelect.disabled = !state.netatmo.locked;
  netatmoResolutionSelect.value = String(state.netatmo.manualResolution);
  netatmoToggleStations.checked = state.netatmo.showStations;
  netatmoToggleHex.checked = state.netatmo.showHex;
  netatmoIncludeSensor.checked = state.netatmo.includeSensorCommunity;

  if (state.netatmo.year) {
    netatmoYearInput.classList.remove("invalid");
  }

  updateNetatmoHourState();
}

function syncSensorUiFromState() {
  sensorDaySelect.value = state.sensor.day ?? "";
  sensorMonthSelect.value = String(state.sensor.month);
  sensorYearInput.value = state.sensor.year ?? "";
  sensorHourSelect.value = state.sensor.hour ?? "";

  sensorLockResolution.checked = state.sensor.locked;
  sensorResolutionSelect.disabled = !state.sensor.locked;
  sensorResolutionSelect.value = String(state.sensor.manualResolution);

  sensorToggleStations.checked = state.sensor.showStations;
  sensorToggleHex.checked = state.sensor.showHex;
  sensorIncludeNetatmo.checked = state.sensor.includeNetatmo;

  if (state.sensor.year) {
    sensorYearInput.classList.remove("invalid");
  }

  updateSensorHourState();
}

syncNetatmoUiFromState();
syncSensorUiFromState();

const mapMessage = document.getElementById("mapMessage");

function showMapMessage(text) {
  if (!mapMessage) return;
  mapMessage.textContent = text;
  mapMessage.classList.remove("hidden");
}

function hideMapMessage() {
  if (!mapMessage) return;
  mapMessage.textContent = "";
  mapMessage.classList.add("hidden");
}

tabBtnNetatmo.addEventListener("click", () => activateTab("netatmo"));
tabBtnSensor.addEventListener("click", () => activateTab("sensor"));

netatmoMonthSelect.addEventListener("change", (e) => {
  state.netatmo.month = parseInt(e.target.value, 10);
});

netatmoDataValSelect.addEventListener("change", (e) => {
  state.netatmo.dataVal = e.target.value || null;
});

netatmoLockResolution.addEventListener("change", (e) => {
  state.netatmo.locked = e.target.checked;
  netatmoResolutionSelect.disabled = !state.netatmo.locked;
  renderActiveTab();
});

netatmoResolutionSelect.addEventListener("change", (e) => {
  state.netatmo.manualResolution = parseInt(e.target.value, 10);
  if (state.activeTab === "netatmo" && state.netatmo.locked) {
    renderActiveTab();
  }
});

netatmoToggleStations.addEventListener("change", (e) => {
  state.netatmo.showStations = e.target.checked;
  if (state.activeTab === "netatmo") {
    stationLayer.setVisible(state.netatmo.showStations);
  }
});

netatmoToggleHex.addEventListener("change", (e) => {
  state.netatmo.showHex = e.target.checked;
  if (state.activeTab === "netatmo") {
    netatmoHexLayer.setVisible(state.netatmo.showHex);
  }
});

netatmoIncludeSensor.addEventListener("change", (e) => {
  state.netatmo.includeSensorCommunity = e.target.checked;
  if (state.activeTab === "netatmo") {
    renderActiveTab();
  }
});

netatmoUpdateBtn.addEventListener("click", () => {
  if (!validateNetatmoYear()) return;
  renderNetatmoTab();
});

sensorLockResolution.addEventListener("change", (e) => {
  state.sensor.locked = e.target.checked;
  sensorResolutionSelect.disabled = !state.sensor.locked;
  if (state.activeTab === "sensor") {
    renderActiveTab();
  }
});

sensorToggleStations.addEventListener("change", (e) => {
  state.sensor.showStations = e.target.checked;
  if (state.activeTab === "sensor") {
    sensorStationLayer.setVisible(state.sensor.showStations);
  }
});

sensorResolutionSelect.addEventListener("change", (e) => {
  state.sensor.manualResolution = parseInt(e.target.value, 10);
  if (state.activeTab === "sensor" && state.sensor.locked) {
    renderActiveTab();
  }
});

sensorToggleHex.addEventListener("change", (e) => {
  state.sensor.showHex = e.target.checked;
  if (state.activeTab === "sensor") {
    sensorHexLayer.setVisible(state.sensor.showHex);
  }
});

sensorIncludeNetatmo.addEventListener("change", (e) => {
  state.sensor.includeNetatmo = e.target.checked;
  if (state.activeTab === "sensor") {
    renderActiveTab();
  }
});

sensorUpdateBtn.addEventListener("click", () => {
  if (!validateSensorYear()) return;
  renderSensorTab();
});

netatmoDaySelect.addEventListener("change", (e) => {
  state.netatmo.day = e.target.value ? parseInt(e.target.value, 10) : null;
  updateNetatmoHourState();
  hideMapMessage();
});

netatmoHourSelect.addEventListener("change", (e) => {
  state.netatmo.hour = e.target.value ? parseInt(e.target.value, 10) : null;
  hideMapMessage();
});

sensorDaySelect.addEventListener("change", (e) => {
  state.sensor.day = e.target.value ? parseInt(e.target.value, 10) : null;
  updateSensorHourState();
  hideMapMessage();
});

sensorMonthSelect.addEventListener("change", (e) => {
  state.sensor.month = parseInt(e.target.value, 10);
  hideMapMessage();
});

sensorYearInput.addEventListener("change", (e) => {
  const value = e.target.value;

  if (!value) {
    state.sensor.year = null;
    sensorYearInput.classList.add("invalid");
    return;
  }

  state.sensor.year = parseInt(value, 10);
  sensorYearInput.classList.remove("invalid");
  hideMapMessage();
});

sensorHourSelect.addEventListener("change", (e) => {
  state.sensor.hour = e.target.value ? parseInt(e.target.value, 10) : null;
  hideMapMessage();
});

netatmoYearInput.addEventListener("change", (e) => {
  const value = e.target.value;

  if (!value) {
    state.netatmo.year = null;
    netatmoYearInput.classList.add("invalid");
    return;
  }

  state.netatmo.year = parseInt(value, 10);
  netatmoYearInput.classList.remove("invalid");
  hideMapMessage();
});

activateTab("netatmo");
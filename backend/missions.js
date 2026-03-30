// ─────────────────────────────────────────────────────────────────────────────
// Space Missions — Data Layer
// Loads space_missions.csv and exposes the 8 required analysis functions.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'space_missions.csv');

// ── CSV Parser ────────────────────────────────────────────────────────────────

function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

// ── Data & Indices ────────────────────────────────────────────────────────────

let MISSIONS      = [];
let companyIndex  = {};  // { [company]: { total, success } }
let yearIndex     = {};  // { [year]: count }
let rocketIndex   = {};  // { [rocket]: count }

function buildIndices() {
  companyIndex = {};
  yearIndex    = {};
  rocketIndex  = {};

  for (const m of MISSIONS) {
    if (!companyIndex[m.company])
      companyIndex[m.company] = { total: 0, success: 0 };
    companyIndex[m.company].total++;
    if (m.missionStatus === 'Success') companyIndex[m.company].success++;

    if (m.year) yearIndex[m.year] = (yearIndex[m.year] || 0) + 1;
    if (m.rocket) rocketIndex[m.rocket] = (rocketIndex[m.rocket] || 0) + 1;
  }
}

function loadData() {
  const raw  = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(raw);

  MISSIONS = rows.map(r => ({
    company:       r.Company,
    location:      r.Location,
    date:          r.Date,
    time:          r.Time,
    rocket:        r.Rocket,
    mission:       r.Mission,
    rocketStatus:  r.RocketStatus,
    price:         r.Price !== '' ? parseFloat(r.Price) : null,
    missionStatus: r.MissionStatus,
    year:          r.Date ? parseInt(r.Date.slice(0, 4), 10) : null,
  }));

  buildIndices();
  console.log(`  Loaded ${MISSIONS.length} missions from CSV`);
}

// ── 8 Required Functions ──────────────────────────────────────────────────────

/**
 * Returns the total number of missions for a given company.
 * @param {string} companyName
 * @returns {number}
 */
function getMissionCountByCompany(companyName) {
  if (!companyName || typeof companyName !== 'string') return 0;
  const entry = companyIndex[companyName.trim()];
  return entry ? entry.total : 0;
}

/**
 * Calculates the success rate for a given company as a percentage (0–100),
 * rounded to 2 decimal places. Returns 0.0 if company has no missions.
 * @param {string} companyName
 * @returns {number}
 */
function getSuccessRate(companyName) {
  if (!companyName || typeof companyName !== 'string') return 0.0;
  const entry = companyIndex[companyName.trim()];
  if (!entry || entry.total === 0) return 0.0;
  return Math.round((entry.success / entry.total) * 10000) / 100;
}

/**
 * Returns a list of all mission names launched between startDate and endDate
 * (inclusive), sorted chronologically.
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {string[]}
 */
function getMissionsByDateRange(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const start = startDate.trim();
  const end   = endDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  if (start > end) return [];
  return MISSIONS
    .filter(m => m.date >= start && m.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(m => m.mission);
}

/**
 * Returns the top N companies ranked by total mission count.
 * Ties are broken alphabetically.
 * @param {number} n
 * @returns {Array<[string, number]>}
 */
function getTopCompaniesByMissionCount(n) {
  const count = parseInt(n, 10);
  if (isNaN(count) || count < 1) return [];
  return Object.entries(companyIndex)
    .map(([name, v]) => [name, v.total])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count);
}

/**
 * Returns the count of missions for each mission status.
 * @returns {{ Success: number, Failure: number, 'Partial Failure': number, 'Prelaunch Failure': number }}
 */
function getMissionStatusCount() {
  const counts = {
    'Success': 0,
    'Failure': 0,
    'Partial Failure': 0,
    'Prelaunch Failure': 0,
  };
  for (const m of MISSIONS) {
    if (Object.prototype.hasOwnProperty.call(counts, m.missionStatus)) {
      counts[m.missionStatus]++;
    }
  }
  return counts;
}

/**
 * Returns the total number of missions launched in a specific year.
 * @param {number} year
 * @returns {number}
 */
function getMissionsByYear(year) {
  const y = parseInt(year, 10);
  if (isNaN(y)) return 0;
  return yearIndex[y] || 0;
}

/**
 * Returns the name of the rocket that has been used the most times.
 * Alphabetical tie-breaking.
 * @returns {string}
 */
function getMostUsedRocket() {
  if (Object.keys(rocketIndex).length === 0) return '';
  const maxCount = Math.max(...Object.values(rocketIndex));
  return Object.entries(rocketIndex)
    .filter(([, c]) => c === maxCount)
    .map(([r]) => r)
    .sort((a, b) => a.localeCompare(b))[0] || '';
}

/**
 * Calculates the average number of missions per year over a given range
 * (inclusive on both ends). Divides total missions by the number of years
 * in the range, rounded to 2 decimal places.
 * @param {number} startYear
 * @param {number} endYear
 * @returns {number}
 */
function getAverageMissionsPerYear(startYear, endYear) {
  const sy = parseInt(startYear, 10);
  const ey = parseInt(endYear, 10);
  if (isNaN(sy) || isNaN(ey) || sy > ey) return 0.0;
  let total = 0;
  const numYears = ey - sy + 1;
  for (let y = sy; y <= ey; y++) {
    total += yearIndex[y] || 0;
  }
  return Math.round((total / numYears) * 100) / 100;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  loadData,
  getMissions:                  () => MISSIONS,
  getMissionCountByCompany,
  getSuccessRate,
  getMissionsByDateRange,
  getTopCompaniesByMissionCount,
  getMissionStatusCount,
  getMissionsByYear,
  getMostUsedRocket,
  getAverageMissionsPerYear,
};

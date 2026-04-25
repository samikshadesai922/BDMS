const http = require('http');
const url = require('url');
const pool = require('./db');
const { sendSMS, buildSMSMessage } = require('./utils/smsService');

const PORT = Number(process.env.PORT || 3002);
const DEFAULT_RADIUS_KM = Number(process.env.DEFAULT_RADIUS_KM || 3);
const DONATION_COOLDOWN_DAYS = Number(process.env.DONATION_COOLDOWN_DAYS || 90);
const DEFAULT_INVENTORY_THRESHOLD = Number(process.env.DEFAULT_INVENTORY_THRESHOLD || 5);
const DEFAULT_REQUEST_EXPIRY_HOURS = Number(process.env.DEFAULT_REQUEST_EXPIRY_HOURS || 6);

const COMPATIBILITY = {
  'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
  'O+': ['O+', 'A+', 'B+', 'AB+'],
  'A-': ['A-', 'A+', 'AB-', 'AB+'],
  'A+': ['A+', 'AB+'],
  'B-': ['B-', 'B+', 'AB-', 'AB+'],
  'B+': ['B+', 'AB+'],
  'AB-': ['AB-', 'AB+'],
  'AB+': ['AB+']
};

const PRIORITY_RANK = {
  Emergency: 3,
  Urgent: 2,
  Normal: 1
};

const ACTIVE_REQUEST_STATUSES = ['Pending', 'Accepted', 'Booked'];
const RARE_BLOOD_GROUPS = new Set(['AB-', 'B-', 'O-']);

function normalizeBloodGroup(value) {
  return String(value || '').trim().toUpperCase().replace(/[−–—]/g, '-');
}

function normalizeUrgency(value) {
  const urgency = String(value || '').trim().toLowerCase();
  if (urgency === 'emergency') return 'Emergency';
  if (urgency === 'urgent') return 'Urgent';
  return 'Normal';
}

function normalizeReason(value) {
  const reason = String(value || '').trim();
  return reason || 'Personal reason';
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function createId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function addHours(value, hours) {
  const date = new Date(value);
  date.setUTCHours(date.getUTCHours() + hours);
  return date;
}

function startOfDay(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function diffDays(fromValue, toValue) {
  const from = startOfDay(fromValue);
  const to = startOfDay(toValue);
  if (!from || !to) return null;
  return Math.ceil((to.getTime() - from.getTime()) / 86400000);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const aLat = toNumber(lat1);
  const aLon = toNumber(lon1);
  const bLat = toNumber(lat2);
  const bLon = toNumber(lon2);
  if ([aLat, aLon, bLat, bLon].some((item) => item === null)) return null;

  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const part =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(part), Math.sqrt(1 - part));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function testDatabaseConnection() {
  return query('SELECT 1 AS ok');
}

function serializeMetadata(value) {
  return value ? JSON.stringify(value) : null;
}

function parseMetadata(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCertificateHtml(certificate) {
  const issuedDate = new Date(certificate.date || certificate.createdAt).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Donation Certificate</title>
  <style>
    body { margin:0; font-family:Arial,sans-serif; background:#f6f6f6; color:#222; }
    .page { max-width:900px; margin:32px auto; background:#fff; border:12px solid #d92b2b; padding:48px; box-shadow:0 8px 30px rgba(0,0,0,.12); }
    .eyebrow { color:#b71c1c; text-transform:uppercase; letter-spacing:3px; font-weight:700; font-size:12px; }
    .title { font-size:40px; font-weight:800; margin:14px 0 8px; }
    .subtitle { font-size:18px; color:#555; margin-bottom:34px; }
    .body-copy { font-size:20px; line-height:1.7; margin:24px 0; }
    .name { font-size:36px; font-weight:800; color:#b71c1c; margin:12px 0; }
    .grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:18px; margin-top:30px; }
    .tile { background:#fff5f5; border:1px solid #f0c2c2; border-radius:14px; padding:18px; }
    .label { font-size:12px; text-transform:uppercase; letter-spacing:1px; color:#8b8b8b; margin-bottom:6px; }
    .value { font-size:19px; font-weight:700; }
    .footer { margin-top:42px; display:flex; justify-content:space-between; align-items:flex-end; gap:16px; }
    .seal { width:120px; height:120px; border-radius:50%; border:4px solid #d92b2b; display:flex; align-items:center; justify-content:center; color:#d92b2b; font-weight:800; text-align:center; font-size:14px; }
    .print-row { margin-top:26px; }
    .print-btn { background:#d92b2b; color:#fff; border:none; border-radius:10px; padding:12px 18px; font-size:15px; font-weight:700; cursor:pointer; }
    @media print {
      body { background:#fff; }
      .page { margin:0; box-shadow:none; }
      .print-row { display:none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="eyebrow">Blood Donation Management System</div>
    <div class="title">Certificate of Donation</div>
    <div class="subtitle">Presented in appreciation of a life-saving blood donation.</div>
    <div class="body-copy">This certifies that</div>
    <div class="name">${escapeHtml(certificate.donorName)}</div>
    <div class="body-copy">successfully donated blood at <strong>${escapeHtml(certificate.hospitalName)}</strong> on <strong>${escapeHtml(issuedDate)}</strong>.</div>
    <div class="grid">
      <div class="tile">
        <div class="label">Blood Group</div>
        <div class="value">${escapeHtml(certificate.bloodGroup)}</div>
      </div>
      <div class="tile">
        <div class="label">Certificate ID</div>
        <div class="value">${escapeHtml(certificate.id)}</div>
      </div>
    </div>
    <div class="footer">
      <div>
        <div class="label">Issued By</div>
        <div class="value">Blood Donation Management System</div>
      </div>
      <div class="seal">DONATION<br>CERTIFIED</div>
    </div>
    <div class="print-row">
      <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    </div>
  </div>
</body>
</html>`;
}

function donorCanHelp(donorBloodGroup, requestBloodGroup, exactMatchOnly) {
  const donorBlood = normalizeBloodGroup(donorBloodGroup);
  const requestBlood = normalizeBloodGroup(requestBloodGroup);
  if (!donorBlood || !requestBlood) return false;
  if (exactMatchOnly) return donorBlood === requestBlood;
  return (COMPATIBILITY[donorBlood] || []).includes(requestBlood);
}

function normalizeHospitalRecord(row) {
  return {
    id: Number(row.id),
    hospitalName: String(row.hospitalName || row.hospital_name || row.name || '').trim(),
    email: String(row.email || '').trim().toLowerCase(),
    phone: String(row.phone || '').trim(),
    address: String(row.address || row.location || '').trim(),
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    createdAt: row.createdAt || row.created_at || null,
    lastUpdated: row.lastUpdated || row.last_updated || null
  };
}

function normalizeRequestRecord(row, extras = {}) {
  const urgency = normalizeUrgency(row.urgency || row.priority);
  const bloodGroup = normalizeBloodGroup(row.bloodGroup || row.blood_group);
  const exactMatchOnly = extras.exactMatchOnly === true || RARE_BLOOD_GROUPS.has(bloodGroup);
  return {
    id: Number(row.id),
    hospitalName: String(row.hospitalName || row.hospital_name || '').trim(),
    bloodGroup,
    units: Number(row.units || 0),
    urgency,
    priority: normalizeUrgency(row.priority || urgency),
    priorityRank: PRIORITY_RANK[normalizeUrgency(row.priority || urgency)],
    department: String(row.department || row.location || '').trim(),
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    radiusKm: Number(row.radiusKm || row.radius_km || DEFAULT_RADIUS_KM),
    status: String(row.status || 'Pending'),
    acceptedDonorId: row.acceptedDonorId != null || row.accepted_donor_id != null ? Number(row.acceptedDonorId || row.accepted_donor_id) : null,
    acceptedDonorName: row.acceptedDonorName || row.accepted_donor_name || null,
    confirmedDonationId: row.confirmedDonationId != null || row.confirmed_donation_id != null ? Number(row.confirmedDonationId || row.confirmed_donation_id) : null,
    confirmedDonorId: row.confirmedDonorId != null || row.confirmed_donor_id != null ? Number(row.confirmedDonorId || row.confirmed_donor_id) : null,
    expiresAt: row.expiresAt || row.expiry_at || null,
    createdAt: row.createdAt || row.created_at || null,
    updatedAt: row.updatedAt || row.updated_at || null,
    emergency: urgency === 'Emergency',
    fastTrack: urgency === 'Emergency',
    exactMatchOnly,
    rareRequest: exactMatchOnly,
    nearbyDonorCount: Number(extras.nearbyDonorCount || row.nearbyDonorCount || 0),
    matchedDonorIds: Array.isArray(extras.matchedDonorIds) ? extras.matchedDonorIds : []
  };
}

function normalizeDonationRecord(row) {
  return {
    id: Number(row.id),
    donorId: row.donorId != null || row.donor_id != null ? Number(row.donorId || row.donor_id) : null,
    donorName: row.donorName || row.donor_name || '',
    requestId: row.requestId != null || row.request_id != null ? Number(row.requestId || row.request_id) : null,
    hospitalName: row.hospitalName || row.hospital_name || '',
    bloodGroup: normalizeBloodGroup(row.bloodGroup || row.blood_group),
    date: row.date || null,
    confirmedAt: row.confirmedAt || row.confirmed_at || null
  };
}

function normalizeCertificateRecord(row) {
  return {
    id: Number(row.id),
    donationId: row.donationId != null || row.donation_id != null ? Number(row.donationId || row.donation_id) : null,
    donorId: row.donorId != null || row.donor_id != null ? Number(row.donorId || row.donor_id) : null,
    donorName: row.donorName || row.donor_name || '',
    hospitalName: row.hospitalName || row.hospital_name || '',
    bloodGroup: normalizeBloodGroup(row.bloodGroup || row.blood_group),
    date: row.date || null,
    content: row.content || '',
    createdAt: row.createdAt || row.created_at || null
  };
}

function normalizeAppointmentRecord(row) {
  return {
    id: Number(row.id),
    hospitalName: row.hospitalName || row.hospital_name || '',
    requestId: row.requestId != null || row.request_id != null ? Number(row.requestId || row.request_id) : null,
    donorId: row.donorId != null || row.donor_id != null ? Number(row.donorId || row.donor_id) : null,
    bloodGroup: normalizeBloodGroup(row.bloodGroup || row.blood_group),
    slot: row.slot || null,
    status: row.status || 'Open',
    acceptedAt: row.acceptedAt || row.accepted_at || null,
    completedAt: row.completedAt || row.completed_at || null,
    createdAt: row.createdAt || row.created_at || null
  };
}

function normalizeInventoryRecord(row) {
  return {
    id: Number(row.id),
    hospitalName: row.hospitalName || row.hospital_name || '',
    bloodGroup: normalizeBloodGroup(row.bloodGroup || row.blood_group),
    unitsAvailable: Number(row.unitsAvailable || row.units_available || 0),
    threshold: Number(row.threshold || row.threshold_units || DEFAULT_INVENTORY_THRESHOLD),
    updatedAt: row.updatedAt || row.updated_at || null
  };
}

function normalizeNotificationRecord(row) {
  return {
    id: Number(row.id),
    type: row.type || '',
    target: row.target || '',
    targetId: row.targetId != null || row.target_id != null ? Number(row.targetId || row.target_id) : null,
    title: row.title || '',
    message: row.message || '',
    status: row.status || '',
    metadata: parseMetadata(row.metadata),
    read: Boolean(row.isRead != null ? row.isRead : row.is_read),
    createdAt: row.createdAt || row.created_at || null
  };
}

async function createNotification(entry) {
  const notification = {
    id: createId(),
    type: entry.type,
    target: entry.target || '',
    targetId: entry.targetId == null ? null : Number(entry.targetId),
    title: entry.title || '',
    message: entry.message || '',
    status: entry.status || 'created',
    metadata: entry.metadata || null,
    read: false,
    createdAt: new Date()
  };

  await query(
    `INSERT INTO notifications
     (id, type, target, target_id, title, message, status, metadata, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      notification.id,
      notification.type,
      notification.target,
      notification.targetId,
      notification.title,
      notification.message,
      notification.status,
      serializeMetadata(notification.metadata),
      0,
      notification.createdAt
    ]
  );

  return normalizeNotificationRecord(notification);
}

function validateDonor(body) {
  const errors = [];
  const lastDonationDate = body.lastDonationDate ? new Date(body.lastDonationDate) : null;
  const donor = {
    name: String(body.name || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    password: String(body.password || '').trim() || null,
    age: Number(body.age),
    weight: Number(body.weight),
    bloodGroup: normalizeBloodGroup(body.bloodGroup || body.blood),
    locationLabel: String(body.locationLabel || body.location || '').trim(),
    phone: String(body.phone || '').trim(),
    latitude: toNumber(body.latitude),
    longitude: toNumber(body.longitude),
    available: body.available !== false,
    lastDonationDate: lastDonationDate && !Number.isNaN(lastDonationDate.getTime()) ? lastDonationDate : null,
    reliabilityScore: Number(body.reliabilityScore || 100)
  };

  if (!donor.name) errors.push('Name is required');
  if (!donor.email || !donor.email.includes('@')) errors.push('Valid email is required');
  if (!Number.isInteger(donor.age) || donor.age < 18 || donor.age > 65) errors.push('Age must be between 18 and 65');
  if (!Number.isFinite(donor.weight) || donor.weight < 50) errors.push('Weight must be at least 50 kg');
  if (!donor.bloodGroup) errors.push('Blood group is required');
  if (!donor.locationLabel) errors.push('Location is required');
  if (!donor.phone) errors.push('Phone number is required');
  if (donor.latitude === null || donor.longitude === null) errors.push('Manual latitude and longitude are required');
  if (body.lastDonationDate && !donor.lastDonationDate) errors.push('Valid last donation date is required');

  return { donor, errors };
}

function validateHospital(body) {
  const errors = [];
  const hospital = {
    hospitalName: String(body.hospitalName || body.name || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    password: String(body.password || '').trim() || null,
    phone: String(body.phone || '').trim(),
    address: String(body.address || body.location || '').trim(),
    latitude: toNumber(body.latitude),
    longitude: toNumber(body.longitude)
  };

  if (!hospital.hospitalName) errors.push('Hospital name is required');
  if (!hospital.email || !hospital.email.includes('@')) errors.push('Valid email is required');
  if (!hospital.phone) errors.push('Phone number is required');
  if (!hospital.address) errors.push('Address is required');
  if (hospital.latitude === null || hospital.longitude === null) errors.push('Manual latitude and longitude are required');

  return { hospital, errors };
}

function validateRequest(body) {
  const errors = [];
  const urgency = normalizeUrgency(body.urgency || body.priority);
  const expiryHours = toNumber(body.expiryHours) || DEFAULT_REQUEST_EXPIRY_HOURS;
  const request = {
    hospitalName: String(body.hospitalName || '').trim(),
    bloodGroup: normalizeBloodGroup(body.bloodGroup),
    units: Number(body.units),
    urgency,
    priority: urgency,
    priorityRank: PRIORITY_RANK[urgency],
    department: String(body.department || body.location || '').trim(),
    latitude: toNumber(body.latitude),
    longitude: toNumber(body.longitude),
    radiusKm: toNumber(body.radiusKm) || DEFAULT_RADIUS_KM,
    fastTrack: body.fastTrack === true || urgency === 'Emergency',
    emergency: body.emergency === true || urgency === 'Emergency',
    exactMatchOnly: RARE_BLOOD_GROUPS.has(normalizeBloodGroup(body.bloodGroup)),
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: addHours(new Date(), expiryHours),
    status: 'Pending'
  };

  request.rareRequest = request.exactMatchOnly;

  if (!request.hospitalName) errors.push('Hospital name is required');
  if (!request.bloodGroup) errors.push('Blood group is required');
  if (!Number.isInteger(request.units) || request.units < 1 || request.units > 10) errors.push('Units must be between 1 and 10');
  if (!request.department) errors.push('Department or location is required');
  if (request.latitude === null || request.longitude === null) errors.push('Location coordinates are required');
  if (request.radiusKm < 1 || request.radiusKm > 50) errors.push('Radius must be between 1 and 50 km');
  if (expiryHours < 1 || expiryHours > 168) errors.push('Expiry must be between 1 and 168 hours');

  return { request, errors };
}

async function getDonationStatsMap(donorIds = null) {
  let sql = `
    SELECT donor_id AS donorId, COUNT(*) AS donationCount, MAX(date) AS lastDonationDate
    FROM donations
  `;
  const params = [];

  if (Array.isArray(donorIds) && donorIds.length) {
    sql += ` WHERE donor_id IN (${donorIds.map(() => '?').join(',')})`;
    params.push(...donorIds);
  }

  sql += ' GROUP BY donor_id';
  const rows = await query(sql, params);
  const map = new Map();
  rows.forEach((row) => {
    map.set(Number(row.donorId), {
      donationCount: Number(row.donationCount || 0),
      lastDonationDate: row.lastDonationDate || null
    });
  });
  return map;
}

async function getBookedRequestsMap(donorIds = null) {
  let sql = `
    SELECT id, accepted_donor_id AS donorId
    FROM requests
    WHERE accepted_donor_id IS NOT NULL
      AND status IN ('Accepted', 'Booked')
  `;
  const params = [];

  if (Array.isArray(donorIds) && donorIds.length) {
    sql += ` AND accepted_donor_id IN (${donorIds.map(() => '?').join(',')})`;
    params.push(...donorIds);
  }

  const rows = await query(sql, params);
  const map = new Map();
  rows.forEach((row) => {
    map.set(Number(row.donorId), Number(row.id));
  });
  return map;
}

function buildEligibility(donor, donationStats, bookedRequestId) {
  const activeDeferral = donor.deferralUntil && new Date(donor.deferralUntil) > new Date()
    ? { reason: donor.deferralReason || 'Personal reason', until: donor.deferralUntil }
    : null;
  const lastDonationDate = donor.lastDonationDate || (donationStats && donationStats.lastDonationDate) || null;
  const nextEligibleDate = lastDonationDate ? addDays(new Date(lastDonationDate), DONATION_COOLDOWN_DAYS) : null;
  const remainingDays = nextEligibleDate ? Math.max(0, diffDays(new Date(), nextEligibleDate)) : 0;

  let eligible = true;
  let reason = 'Ready to donate';
  let readinessStatus = 'Ready to Donate';

  if (activeDeferral) {
    eligible = false;
    readinessStatus = 'Temporarily Unavailable';
    reason = `${activeDeferral.reason} until ${new Date(activeDeferral.until).toISOString()}`;
  } else if (Number(donor.age) < 18 || Number(donor.age) > 65 || Number(donor.weight) < 50) {
    eligible = false;
    readinessStatus = 'Not Eligible';
    reason = 'Donor does not meet age/weight requirements';
  } else if (bookedRequestId) {
    eligible = false;
    readinessStatus = 'Temporarily Unavailable';
    reason = `Booked for request #${bookedRequestId}`;
  } else if (nextEligibleDate && remainingDays > 0) {
    eligible = false;
    readinessStatus = 'Not Eligible';
    reason = `You can donate again on ${nextEligibleDate.toISOString()}`;
  } else if (donor.requestedAvailability === false) {
    eligible = false;
    readinessStatus = 'Temporarily Unavailable';
    reason = 'Availability turned off';
  }

  return {
    eligible,
    reason,
    readinessStatus,
    cooldownDays: DONATION_COOLDOWN_DAYS,
    lastDonationDate,
    nextEligibleDate: nextEligibleDate ? nextEligibleDate.toISOString() : null,
    remainingDays,
    bookedRequestId: bookedRequestId || null,
    deferral: activeDeferral
  };
}

function normalizeDonorRecord(row, donationStats = { donationCount: 0, lastDonationDate: null }, bookedRequestId = null) {
  const donor = {
    id: Number(row.id),
    name: String(row.name || '').trim(),
    email: String(row.email || '').trim().toLowerCase(),
    phone: String(row.phone || '').trim(),
    age: Number(row.age),
    weight: Number(row.weight),
    bloodGroup: normalizeBloodGroup(row.bloodGroup || row.blood_group),
    blood: normalizeBloodGroup(row.bloodGroup || row.blood_group),
    locationLabel: String(row.locationLabel || row.location_label || row.location || '').trim(),
    location: String(row.locationLabel || row.location_label || row.location || '').trim(),
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    requestedAvailability: Boolean(Number(row.available)),
    lastDonationDate: row.lastDonationDate || row.last_donation_date || donationStats.lastDonationDate || null,
    reliabilityScore: Math.max(0, Number(row.reliabilityScore != null ? row.reliabilityScore : row.reliability_score || 100)),
    deferralReason: row.deferralReason || row.deferral_reason || null,
    deferralUntil: row.deferralUntil || row.deferral_until || null,
    createdAt: row.createdAt || row.created_at || null,
    lastUpdated: row.lastUpdated || row.last_updated || null
  };

  const eligibility = buildEligibility(donor, donationStats, bookedRequestId);
  return {
    ...donor,
    available: donor.requestedAvailability && eligibility.eligible,
    deferral: eligibility.deferral,
    donationCount: Number(donationStats.donationCount || 0),
    rareDonor: RARE_BLOOD_GROUPS.has(donor.bloodGroup),
    eligibility,
    impact: {
      totalDonations: Number(donationStats.donationCount || 0),
      estimatedLivesHelped: Number(donationStats.donationCount || 0) * 3
    }
  };
}

async function readDonorsFromDb(filters = {}) {
  let sql = `
    SELECT
      id,
      name,
      email,
      phone,
      password,
      age,
      weight,
      blood_group AS bloodGroup,
      location_label AS locationLabel,
      latitude,
      longitude,
      last_donation_date AS lastDonationDate,
      available,
      reliability_score AS reliabilityScore,
      deferral_reason AS deferralReason,
      deferral_until AS deferralUntil,
      created_at AS createdAt,
      last_updated AS lastUpdated
    FROM donors
    WHERE 1 = 1
  `;
  const params = [];

  if (filters.id != null) {
    sql += ' AND id = ?';
    params.push(Number(filters.id));
  }
  if (filters.email) {
    sql += ' AND LOWER(email) = ?';
    params.push(String(filters.email).trim().toLowerCase());
  }
  if (filters.bloodGroup) {
    sql += ' AND blood_group = ?';
    params.push(normalizeBloodGroup(filters.bloodGroup));
  }
  if (filters.location) {
    sql += ' AND LOWER(location_label) LIKE ?';
    params.push(`%${String(filters.location).trim().toLowerCase()}%`);
  }
  if (filters.availability === 'available') sql += ' AND available = 1';
  if (filters.availability === 'unavailable') sql += ' AND available = 0';

  sql += ' ORDER BY reliability_score DESC, name ASC';

  const rows = await query(sql, params);
  if (!rows.length) return [];

  const donorIds = rows.map((row) => Number(row.id));
  const [donationStatsMap, bookedMap] = await Promise.all([
    getDonationStatsMap(donorIds),
    getBookedRequestsMap(donorIds)
  ]);

  return rows.map((row) => normalizeDonorRecord(
    row,
    donationStatsMap.get(Number(row.id)) || { donationCount: 0, lastDonationDate: row.lastDonationDate || null },
    bookedMap.get(Number(row.id)) || null
  ));
}

async function getDonorById(donorId) {
  const donors = await readDonorsFromDb({ id: donorId });
  return donors[0] || null;
}

async function getDonorByIdOrEmail(donorId, email) {
  if (donorId != null && Number.isFinite(Number(donorId))) {
    const donorById = await getDonorById(Number(donorId));
    if (donorById) return donorById;
  }
  if (email) {
    const donors = await readDonorsFromDb({ email });
    return donors[0] || null;
  }
  return null;
}

async function getRequestById(requestId) {
  const rows = await query(
    `SELECT
      id,
      hospital_name AS hospitalName,
      blood_group AS bloodGroup,
      units,
      urgency,
      priority,
      department,
      latitude,
      longitude,
      radius_km AS radiusKm,
      status,
      accepted_donor_id AS acceptedDonorId,
      accepted_donor_name AS acceptedDonorName,
      confirmed_donation_id AS confirmedDonationId,
      confirmed_donor_id AS confirmedDonorId,
      expiry_at AS expiresAt,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM requests
     WHERE id = ?`,
    [requestId]
  );
  return rows[0] ? normalizeRequestRecord(rows[0]) : null;
}

async function getNearbyDonorsFromDb(latitude, longitude, bloodGroup, radiusKm, availabilityOnly, options = {}) {
  const request = {
    latitude,
    longitude,
    bloodGroup: normalizeBloodGroup(bloodGroup),
    radiusKm: radiusKm || DEFAULT_RADIUS_KM
  };
  const exactMatchOnly = options.exactMatchOnly === true || RARE_BLOOD_GROUPS.has(request.bloodGroup);
  const donors = await readDonorsFromDb();

  return donors
    .map((donor) => {
      const distanceKm = haversineKm(request.latitude, request.longitude, donor.latitude, donor.longitude);
      const compatibility = donorCanHelp(donor.bloodGroup, request.bloodGroup, exactMatchOnly);
      const withinRadius = distanceKm !== null && distanceKm <= request.radiusKm;
      if (!compatibility || !withinRadius) return null;
      const matchScore = (donor.eligibility.eligible ? 100 : 0) + donor.reliabilityScore + Math.max(0, request.radiusKm - distanceKm);
      return {
        ...donor,
        distanceKm: Number(distanceKm.toFixed(1)),
        compatible: compatibility,
        eligible: donor.eligibility.eligible,
        matchScore: Number(matchScore.toFixed(1))
      };
    })
    .filter(Boolean)
    .filter((donor) => (availabilityOnly ? donor.available : true))
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (left.available !== right.available) return left.available ? -1 : 1;
      if (right.reliabilityScore !== left.reliabilityScore) return right.reliabilityScore - left.reliabilityScore;
      if (right.matchScore !== left.matchScore) return right.matchScore - left.matchScore;
      return left.distanceKm - right.distanceKm;
    });
}

async function readRequestsFromDb(filters = {}, withMatchCounts = false) {
  let sql = `
    SELECT
      id,
      hospital_name AS hospitalName,
      blood_group AS bloodGroup,
      units,
      urgency,
      priority,
      department,
      latitude,
      longitude,
      radius_km AS radiusKm,
      status,
      accepted_donor_id AS acceptedDonorId,
      accepted_donor_name AS acceptedDonorName,
      confirmed_donation_id AS confirmedDonationId,
      confirmed_donor_id AS confirmedDonorId,
      expiry_at AS expiresAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM requests
    WHERE 1 = 1
  `;
  const params = [];
  if (filters.hospitalName) {
    sql += ' AND LOWER(hospital_name) = ?';
    params.push(String(filters.hospitalName).trim().toLowerCase());
  }
  sql += ' ORDER BY created_at DESC';

  const rows = await query(sql, params);
  const requests = rows.map((row) => normalizeRequestRecord(row));
  if (!withMatchCounts) return requests;

  const enriched = await Promise.all(requests.map(async (request) => {
    const matchedDonors = await getNearbyDonorsFromDb(
      request.latitude,
      request.longitude,
      request.bloodGroup,
      request.radiusKm,
      true,
      { exactMatchOnly: request.exactMatchOnly }
    );
    return {
      ...request,
      nearbyDonorCount: matchedDonors.length,
      matchedDonorIds: matchedDonors.map((donor) => donor.id)
    };
  }));

  return enriched.sort((a, b) => {
    if (b.priorityRank !== a.priorityRank) return b.priorityRank - a.priorityRank;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

async function getAppointmentById(appointmentId) {
  const rows = await query(
    `SELECT
      id,
      hospital_name AS hospitalName,
      request_id AS requestId,
      donor_id AS donorId,
      blood_group AS bloodGroup,
      slot,
      status,
      accepted_at AS acceptedAt,
      completed_at AS completedAt,
      created_at AS createdAt
     FROM appointments
     WHERE id = ?`,
    [appointmentId]
  );
  return rows[0] ? normalizeAppointmentRecord(rows[0]) : null;
}

async function readNotificationsFromDb() {
  const rows = await query(
    `SELECT
      id,
      type,
      target,
      target_id AS targetId,
      title,
      message,
      status,
      metadata,
      is_read AS isRead,
      created_at AS createdAt
     FROM notifications
     ORDER BY created_at DESC`
  );
  return rows.map(normalizeNotificationRecord);
}

async function logEmail(recipients, subject, message, metadata) {
  const list = Array.isArray(recipients) ? recipients : [];
  return Promise.all(list.map((recipient) => createNotification({
    type: 'email',
    target: recipient.email || '',
    targetId: recipient.id || null,
    title: subject,
    message,
    status: 'logged',
    metadata
  })));
}

async function logBackendAlert(recipients, title, message, metadata) {
  const list = Array.isArray(recipients) ? recipients : [];
  return Promise.all(list.map((recipient) => createNotification({
    type: 'backend-alert',
    target: recipient.name || recipient.hospitalName || '',
    targetId: recipient.id || null,
    title,
    message,
    status: 'created',
    metadata
  })));
}

async function notifyDonors(donors, request, message) {
  const sms = await sendSMS(donors, message);
  const smsNotifications = await Promise.all(sms.map((item, index) => createNotification({
    type: 'sms',
    target: item.phone,
    targetId: donors[index] ? donors[index].id : null,
    title: request.urgency === 'Emergency' ? 'Emergency Request' : 'Donation Request',
    message,
    status: item.status,
    metadata: { requestId: request.id, hospitalName: request.hospitalName }
  })));
  const emailNotifications = await logEmail(
    donors,
    `${request.urgency} blood request`,
    message,
    { requestId: request.id, bloodGroup: request.bloodGroup }
  );
  const backendAlerts = await logBackendAlert(
    donors,
    `${request.urgency} donor alert`,
    message,
    { requestId: request.id, priority: request.priority }
  );

  return {
    sms,
    emailNotifications: emailNotifications.map(normalizeNotificationRecord),
    backendAlerts: backendAlerts.map(normalizeNotificationRecord),
    notificationCount: smsNotifications.length + emailNotifications.length + backendAlerts.length
  };
}

async function insertRequestRecord(request, matchedDonors = []) {
  await query(
    `INSERT INTO requests
     (id, hospital_name, blood_group, units, urgency, priority, department, latitude, longitude,
      radius_km, status, accepted_donor_id, accepted_donor_name, confirmed_donation_id,
      confirmed_donor_id, expiry_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      request.hospitalName,
      request.bloodGroup,
      request.units,
      request.urgency,
      request.priority,
      request.department,
      request.latitude,
      request.longitude,
      request.radiusKm,
      request.status,
      null,
      null,
      null,
      null,
      request.expiresAt,
      request.createdAt,
      request.updatedAt
    ]
  );

  return {
    ...request,
    nearbyDonorCount: matchedDonors.length,
    matchedDonorIds: matchedDonors.map((donor) => donor.id)
  };
}

async function updateDonorReliability(donorId, delta) {
  await query(
    `UPDATE donors
     SET reliability_score = GREATEST(0, COALESCE(reliability_score, 100) + ?), last_updated = ?
     WHERE id = ?`,
    [delta, new Date(), donorId]
  );
}

async function getAnalytics() {
  const [donors, hospitals, requests, donations] = await Promise.all([
    readDonorsFromDb(),
    query(`SELECT id, hospital_name AS hospitalName, email, phone, address, latitude, longitude, created_at AS createdAt, last_updated AS lastUpdated FROM hospitals`).then((rows) => rows.map(normalizeHospitalRecord)),
    readRequestsFromDb(),
    query(`SELECT id, donor_id AS donorId, donor_name AS donorName, request_id AS requestId, hospital_name AS hospitalName, blood_group AS bloodGroup, date, confirmed_at AS confirmedAt FROM donations`).then((rows) => rows.map(normalizeDonationRecord))
  ]);

  const mostRequestedBloodGroups = Object.entries(
    requests.reduce((acc, item) => {
      const group = normalizeBloodGroup(item.bloodGroup);
      acc[group] = (acc[group] || 0) + 1;
      return acc;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .map(([bloodGroup, count]) => ({ bloodGroup, count }));

  return {
    totalDonations: donations.length,
    activeDonors: donors.filter((donor) => donor.available).length,
    totalDonors: donors.length,
    totalHospitals: hospitals.length,
    totalRequests: requests.length,
    activeRequests: requests.filter((request) => ACTIVE_REQUEST_STATUSES.includes(String(request.status))).length,
    completedDonations: donations.length,
    estimatedLivesHelped: donations.length * 3,
    emergencyRequests: requests.filter((request) => request.urgency === 'Emergency').length,
    mostRequestedBloodGroups
  };
}

function buildAppointmentSummary(appointment) {
  return appointment ? {
    id: appointment.id,
    requestId: appointment.requestId || null,
    donorId: appointment.donorId || null,
    hospitalName: appointment.hospitalName,
    slot: appointment.slot,
    status: appointment.status
  } : null;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        cooldownDays: DONATION_COOLDOWN_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS
      });
    }

    if (method === 'POST' && pathname === '/admin/login') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const rows = await query(
        'SELECT id, username, password, name FROM admins WHERE username = ? LIMIT 1',
        [username]
      );
      const admin = rows[0];
      if (!admin || admin.password !== password) {
        return sendJson(res, 401, { error: 'Invalid admin credentials' });
      }
      return sendJson(res, 200, {
        success: true,
        admin: { id: admin.id, username: admin.username, name: admin.name }
      });
    }

    if (method === 'GET' && pathname === '/admin/overview') {
      const [overview, donors, hospitals, requests, donations] = await Promise.all([
        getAnalytics(),
        readDonorsFromDb(),
        query(`SELECT id, hospital_name AS hospitalName, email, phone, address, latitude, longitude, created_at AS createdAt, last_updated AS lastUpdated FROM hospitals ORDER BY id DESC`).then((rows) => rows.map(normalizeHospitalRecord)),
        readRequestsFromDb({}, true),
        query(`SELECT id, donor_id AS donorId, donor_name AS donorName, request_id AS requestId, hospital_name AS hospitalName, blood_group AS bloodGroup, date, confirmed_at AS confirmedAt FROM donations ORDER BY id DESC`).then((rows) => rows.map(normalizeDonationRecord))
      ]);
      return sendJson(res, 200, { overview, donors, hospitals, requests, donations });
    }

    if (method === 'POST' && pathname === '/add-hospital') {
      const body = await readBody(req);
      const { hospital, errors } = validateHospital(body);
      if (errors.length) return sendJson(res, 400, { error: errors.join(', ') });

      const existing = await query('SELECT id FROM hospitals WHERE email = ? LIMIT 1', [hospital.email]);
      if (existing.length) {
        await query(
          `UPDATE hospitals
           SET hospital_name = ?, password = COALESCE(?, password), phone = ?, address = ?, latitude = ?, longitude = ?, last_updated = ?
           WHERE id = ?`,
          [hospital.hospitalName, hospital.password, hospital.phone, hospital.address, hospital.latitude, hospital.longitude, new Date(), existing[0].id]
        );
        const rows = await query(
          `SELECT id, hospital_name AS hospitalName, email, phone, address, latitude, longitude, created_at AS createdAt, last_updated AS lastUpdated
           FROM hospitals WHERE id = ?`,
          [existing[0].id]
        );
        return sendJson(res, 200, { success: true, mode: 'updated', hospital: normalizeHospitalRecord(rows[0]) });
      }

      const created = {
        id: createId(),
        createdAt: new Date(),
        lastUpdated: new Date(),
        ...hospital
      };
      await query(
        `INSERT INTO hospitals
         (id, hospital_name, email, phone, password, address, latitude, longitude, created_at, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          created.id,
          created.hospitalName,
          created.email,
          created.phone,
          created.password,
          created.address,
          created.latitude,
          created.longitude,
          created.createdAt,
          created.lastUpdated
        ]
      );
      return sendJson(res, 200, { success: true, mode: 'created', hospital: normalizeHospitalRecord(created) });
    }

    if (method === 'GET' && pathname === '/hospitals') {
      const location = String(parsedUrl.query.location || '').trim().toLowerCase();
      let sql = `
        SELECT
          id,
          hospital_name AS hospitalName,
          email,
          phone,
          address,
          latitude,
          longitude,
          created_at AS createdAt,
          last_updated AS lastUpdated
        FROM hospitals
      `;
      const params = [];
      if (location) {
        sql += ' WHERE LOWER(address) LIKE ?';
        params.push(`%${location}%`);
      }
      sql += ' ORDER BY hospital_name ASC';
      const hospitals = (await query(sql, params)).map(normalizeHospitalRecord);
      return sendJson(res, 200, { hospitals, total: hospitals.length });
    }

    if (method === 'POST' && pathname === '/add-donor') {
      const body = await readBody(req);
      const { donor, errors } = validateDonor(body);
      if (errors.length) return sendJson(res, 400, { error: errors.join(', ') });

      const existing = await query(
        'SELECT id FROM donors WHERE email = ? OR phone = ? LIMIT 1',
        [donor.email, donor.phone]
      );

      if (existing.length) {
        await query(
          `UPDATE donors
           SET name = ?, password = COALESCE(?, password), age = ?, weight = ?, blood_group = ?, location_label = ?,
               latitude = ?, longitude = ?, last_donation_date = ?, available = ?, reliability_score = ?, last_updated = ?
           WHERE id = ?`,
          [
            donor.name,
            donor.password,
            donor.age,
            donor.weight,
            donor.bloodGroup,
            donor.locationLabel,
            donor.latitude,
            donor.longitude,
            donor.lastDonationDate,
            donor.available ? 1 : 0,
            donor.reliabilityScore,
            new Date(),
            existing[0].id
          ]
        );
        const updated = await getDonorById(existing[0].id);
        return sendJson(res, 200, { success: true, mode: 'updated', donor: updated });
      }

      const created = {
        id: createId(),
        createdAt: new Date(),
        lastUpdated: new Date(),
        ...donor
      };

      await query(
        `INSERT INTO donors
         (id, name, email, phone, password, age, weight, blood_group, location_label, latitude, longitude,
          last_donation_date, available, reliability_score, deferral_reason, deferral_until, created_at, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          created.id,
          created.name,
          created.email,
          created.phone,
          created.password,
          created.age,
          created.weight,
          created.bloodGroup,
          created.locationLabel,
          created.latitude,
          created.longitude,
          created.lastDonationDate,
          created.available ? 1 : 0,
          created.reliabilityScore,
          null,
          null,
          created.createdAt,
          created.lastUpdated
        ]
      );

      const saved = await getDonorById(created.id);
      return sendJson(res, 200, { success: true, mode: 'created', donor: saved });
    }

    if (method === 'GET' && pathname === '/donors') {
      const donors = await readDonorsFromDb({
        bloodGroup: parsedUrl.query.bloodGroup,
        location: parsedUrl.query.location,
        availability: parsedUrl.query.availability
      });
      return sendJson(res, 200, { donors, total: donors.length });
    }

    if (method === 'POST' && pathname === '/donors/update-status') {
      const body = await readBody(req);
      const donor = await getDonorByIdOrEmail(Number(body.donorId), body.email);
      if (!donor) return sendJson(res, 404, { error: 'Donor not found' });

      await query(
        `UPDATE donors SET available = ?, last_updated = ? WHERE id = ?`,
        [body.available === true ? 1 : 0, new Date(), donor.id]
      );
      const updated = await getDonorById(donor.id);
      return sendJson(res, 200, { success: true, donor: updated });
    }

    if (method === 'POST' && pathname === '/donors/update-location') {
      const body = await readBody(req);
      const locationLabel = String(body.locationLabel || '').trim();
      const latitude = toNumber(body.latitude);
      const longitude = toNumber(body.longitude);
      if (!locationLabel || latitude === null || longitude === null) {
        return sendJson(res, 400, { error: 'Manual location, latitude, and longitude are required' });
      }
      const donor = await getDonorByIdOrEmail(Number(body.donorId), body.email);
      if (!donor) return sendJson(res, 404, { error: 'Donor not found' });

      await query(
        `UPDATE donors
         SET location_label = ?, latitude = ?, longitude = ?, last_updated = ?
         WHERE id = ?`,
        [locationLabel, latitude, longitude, new Date(), donor.id]
      );
      const updated = await getDonorById(donor.id);
      return sendJson(res, 200, { success: true, donor: updated });
    }

    if (method === 'POST' && pathname === '/donors/deferral') {
      const body = await readBody(req);
      const days = Math.max(1, Number(body.days || 7));
      const donor = await getDonorByIdOrEmail(Number(body.donorId), body.email);
      if (!donor) return sendJson(res, 404, { error: 'Donor not found' });

      await query(
        `UPDATE donors
         SET deferral_reason = ?, deferral_until = ?, available = 0, last_updated = ?
         WHERE id = ?`,
        [normalizeReason(body.reason), addDays(new Date(), days), new Date(), donor.id]
      );
      const updated = await getDonorById(donor.id);
      return sendJson(res, 200, { success: true, donor: updated });
    }

    if (method === 'GET' && pathname === '/donors/nearby') {
      const lat = toNumber(parsedUrl.query.lat);
      const lon = toNumber(parsedUrl.query.lon);
      const bloodGroup = normalizeBloodGroup(parsedUrl.query.bloodGroup);
      const radius = toNumber(parsedUrl.query.radius) || DEFAULT_RADIUS_KM;
      const availableOnly = String(parsedUrl.query.available || '').toLowerCase() === 'true';
      const eligibleOnly = String(parsedUrl.query.eligible || 'true').toLowerCase() !== 'false';
      if (lat === null || lon === null || !bloodGroup) {
        return sendJson(res, 400, { error: 'lat, lon and bloodGroup are required' });
      }
      let donors = await getNearbyDonorsFromDb(lat, lon, bloodGroup, radius, availableOnly);
      if (eligibleOnly) donors = donors.filter((item) => item.eligible);
      return sendJson(res, 200, { donors, total: donors.length, radiusKm: radius });
    }

    if (method === 'GET' && pathname === '/requests') {
      const requests = await readRequestsFromDb({ hospitalName: parsedUrl.query.hospitalName }, true);
      return sendJson(res, 200, { requests, total: requests.length });
    }

    if (method === 'POST' && (pathname === '/request-blood' || pathname === '/requests/fast-track')) {
      const body = await readBody(req);
      if (pathname === '/requests/fast-track') {
        body.fastTrack = true;
        body.urgency = body.urgency || 'Emergency';
      }

      const { request, errors } = validateRequest(body);
      if (errors.length) return sendJson(res, 400, { error: errors.join(', ') });

      const nearbyDonors = (await getNearbyDonorsFromDb(
        request.latitude,
        request.longitude,
        request.bloodGroup,
        request.radiusKm,
        true,
        { exactMatchOnly: request.exactMatchOnly }
      )).filter((donor) => donor.eligible);

      const newRequest = await insertRequestRecord({ id: createId(), ...request }, nearbyDonors);
      const smsMessage = buildSMSMessage(request.bloodGroup, request.hospitalName, request.urgency);
      const notifications = await notifyDonors(nearbyDonors, newRequest, smsMessage);
      await createNotification({
        type: 'request-created',
        target: newRequest.hospitalName,
        title: `${newRequest.urgency} request created`,
        message: `${newRequest.hospitalName} requested ${newRequest.units} unit(s) of ${newRequest.bloodGroup}`,
        status: 'created',
        metadata: { requestId: newRequest.id, rareRequest: newRequest.rareRequest }
      });

      return sendJson(res, 200, {
        success: true,
        request: newRequest,
        nearbyDonors: nearbyDonors.length,
        donors: nearbyDonors,
        sms: notifications.sms,
        notifications
      });
    }

    if (method === 'POST' && pathname === '/requests/respond') {
      const body = await readBody(req);
      const donorId = Number(body.donorId);
      const requestId = Number(body.requestId);
      const action = String(body.action || '').trim().toLowerCase();
      const donor = await getDonorById(donorId);
      const request = await getRequestById(requestId);
      if (!request) return sendJson(res, 404, { error: 'Request not found' });
      if (!donor) return sendJson(res, 404, { error: 'Donor not found' });
      if (request.status === 'Expired') return sendJson(res, 400, { error: 'Request has expired' });
      if (action === 'accept' && !donor.eligibility.eligible) return sendJson(res, 400, { error: donor.eligibility.reason });
      if (!['accept', 'decline'].includes(action)) return sendJson(res, 400, { error: 'Action must be accept or decline' });

      if (action === 'accept') {
        const existing = await query(
          `SELECT id FROM requests
           WHERE accepted_donor_id = ? AND status IN ('Accepted', 'Booked') AND id <> ?
           LIMIT 1`,
          [donorId, requestId]
        );
        if (existing.length) {
          return sendJson(res, 400, { error: 'Donor is already booked for another request' });
        }

        await query(
          `UPDATE requests
           SET accepted_donor_id = ?, accepted_donor_name = ?, status = 'Booked', updated_at = ?
           WHERE id = ?`,
          [donorId, donor.name, new Date(), requestId]
        );
        await updateDonorReliability(donorId, 5);
      } else {
        if (request.acceptedDonorId && Number(request.acceptedDonorId) === donorId) {
          await query(
            `UPDATE requests
             SET accepted_donor_id = NULL, accepted_donor_name = NULL, status = 'Pending', updated_at = ?
             WHERE id = ?`,
            [new Date(), requestId]
          );
        }
        await updateDonorReliability(donorId, -5);
      }

      const responseStatus = action === 'accept' ? 'Accepted' : 'Declined';
      await createNotification({
        type: 'request-response',
        target: request.hospitalName,
        targetId: donorId,
        title: `Donor ${responseStatus.toLowerCase()} request`,
        message: `${donor.name} ${responseStatus.toLowerCase()} request ${request.id}`,
        status: 'created',
        metadata: { requestId: request.id, donorId }
      });

      return sendJson(res, 200, {
        success: true,
        request: await getRequestById(requestId),
        donor: await getDonorById(donorId)
      });
    }

    if (method === 'POST' && pathname === '/requests/clear') {
      const body = await readBody(req);
      const requestId = Number(body.requestId);
      const request = await getRequestById(requestId);
      if (!request) return sendJson(res, 404, { error: 'Request not found' });

      await query('DELETE FROM requests WHERE id = ?', [requestId]);
      await createNotification({
        type: 'request-cleared',
        target: request.hospitalName || '',
        title: 'Blood request cleared',
        message: `Request ${request.id} was cleared from the dashboard`,
        status: 'created',
        metadata: { requestId: request.id }
      });

      return sendJson(res, 200, { success: true, removed: request });
    }

    if (method === 'POST' && pathname === '/send-sms') {
      const body = await readBody(req);
      const donors = Array.isArray(body.donors) ? body.donors : [];
      const message = String(body.message || '').trim();
      if (!donors.length) return sendJson(res, 400, { error: 'No donors provided' });
      if (!message) return sendJson(res, 400, { error: 'message is required' });

      const results = await sendSMS(donors, message);
      await Promise.all(results.map((result, index) => createNotification({
        type: 'sms',
        target: result.phone,
        targetId: donors[index] ? donors[index].id : null,
        title: 'Manual donor message',
        message,
        status: result.status
      })));

      return sendJson(res, 200, { success: true, results });
    }

    if (method === 'GET' && pathname === '/notifications') {
      const notifications = await readNotificationsFromDb();
      return sendJson(res, 200, { notifications, total: notifications.length });
    }

    if (method === 'GET' && /^\/donors\/\d+\/history$/.test(pathname)) {
      const donorId = Number(pathname.match(/^\/donors\/(\d+)\/history$/)[1]);
      const donor = await getDonorById(donorId);
      if (!donor) return sendJson(res, 404, { error: 'Donor not found' });

      const [donations, certificates] = await Promise.all([
        query(
          `SELECT id, donor_id AS donorId, donor_name AS donorName, request_id AS requestId, hospital_name AS hospitalName,
                  blood_group AS bloodGroup, date, confirmed_at AS confirmedAt
           FROM donations WHERE donor_id = ? ORDER BY date DESC`,
          [donorId]
        ).then((rows) => rows.map(normalizeDonationRecord)),
        query(
          `SELECT id, donation_id AS donationId, donor_id AS donorId, donor_name AS donorName, hospital_name AS hospitalName,
                  blood_group AS bloodGroup, date, content, created_at AS createdAt
           FROM certificates WHERE donor_id = ? ORDER BY created_at DESC`,
          [donorId]
        ).then((rows) => rows.map(normalizeCertificateRecord))
      ]);

      return sendJson(res, 200, { donorId, donations, certificates, total: donations.length });
    }

    if (method === 'GET' && pathname === '/donation-history') {
      const donorId = toNumber(parsedUrl.query.donorId);
      const hospitalName = String(parsedUrl.query.hospitalName || '').trim().toLowerCase();
      let sql = `
        SELECT id, donor_id AS donorId, donor_name AS donorName, request_id AS requestId, hospital_name AS hospitalName,
               blood_group AS bloodGroup, date, confirmed_at AS confirmedAt
        FROM donations
        WHERE 1 = 1
      `;
      const params = [];
      if (donorId !== null) {
        sql += ' AND donor_id = ?';
        params.push(donorId);
      }
      if (hospitalName) {
        sql += ' AND LOWER(hospital_name) = ?';
        params.push(hospitalName);
      }
      sql += ' ORDER BY date DESC';
      const donations = (await query(sql, params)).map(normalizeDonationRecord);
      return sendJson(res, 200, { donations, total: donations.length });
    }

    if (method === 'GET' && pathname === '/certificates') {
      const donorId = toNumber(parsedUrl.query.donorId);
      let sql = `
        SELECT id, donation_id AS donationId, donor_id AS donorId, donor_name AS donorName, hospital_name AS hospitalName,
               blood_group AS bloodGroup, date, content, created_at AS createdAt
        FROM certificates
      `;
      const params = [];
      if (donorId !== null) {
        sql += ' WHERE donor_id = ?';
        params.push(donorId);
      }
      sql += ' ORDER BY created_at DESC';
      const certificates = (await query(sql, params)).map(normalizeCertificateRecord);
      return sendJson(res, 200, { certificates, total: certificates.length });
    }

    if (method === 'GET' && /^\/certificates\/\d+\/download$/.test(pathname)) {
      const certificateId = Number(pathname.match(/^\/certificates\/(\d+)\/download$/)[1]);
      const rows = await query(
        `SELECT id, donation_id AS donationId, donor_id AS donorId, donor_name AS donorName, hospital_name AS hospitalName,
                blood_group AS bloodGroup, date, content, created_at AS createdAt
         FROM certificates
         WHERE id = ?`,
        [certificateId]
      );
      const certificate = rows[0] ? normalizeCertificateRecord(rows[0]) : null;
      if (!certificate) return sendHtml(res, 404, '<h1>Certificate not found</h1>');
      return sendHtml(res, 200, renderCertificateHtml(certificate));
    }

    if (method === 'POST' && pathname === '/donations/confirm') {
      const body = await readBody(req);
      const donorId = Number(body.donorId);
      const requestId = Number(body.requestId);
      const donor = await getDonorById(donorId);
      const request = await getRequestById(requestId);
      if (!donor) return sendJson(res, 404, { error: 'Donor not found' });

      const donationDate = body.date ? new Date(body.date) : new Date();
      if (Number.isNaN(donationDate.getTime())) return sendJson(res, 400, { error: 'Invalid donation date' });

      const record = {
        id: createId(),
        donorId,
        donorName: donor.name,
        requestId: request ? request.id : null,
        hospitalName: String(body.hospitalName || (request && request.hospitalName) || '').trim(),
        bloodGroup: normalizeBloodGroup(body.bloodGroup || donor.bloodGroup || (request && request.bloodGroup)),
        date: donationDate,
        confirmedAt: new Date()
      };

      await query(
        `INSERT INTO donations
         (id, donor_id, donor_name, request_id, hospital_name, blood_group, date, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.donorId,
          record.donorName,
          record.requestId,
          record.hospitalName,
          record.bloodGroup,
          record.date,
          record.confirmedAt
        ]
      );

      await query(
        `UPDATE donors
         SET last_donation_date = ?, available = 0, last_updated = ?
         WHERE id = ?`,
        [record.date, new Date(), donorId]
      );

      let appointment = null;
      if (body.appointmentId) {
        await query(
          `UPDATE appointments SET status = 'Completed', completed_at = ? WHERE id = ?`,
          [new Date(), Number(body.appointmentId)]
        );
        appointment = await getAppointmentById(Number(body.appointmentId));
      }

      if (request) {
        await query(
          `UPDATE requests
           SET status = 'Completed', confirmed_donation_id = ?, confirmed_donor_id = ?, updated_at = ?
           WHERE id = ?`,
          [record.id, donorId, new Date(), requestId]
        );
      }

      await updateDonorReliability(donorId, 10);

      const certificate = {
        id: createId(),
        donationId: record.id,
        donorId: record.donorId,
        donorName: record.donorName,
        hospitalName: record.hospitalName,
        bloodGroup: record.bloodGroup,
        date: record.date,
        content: `Certificate of Donation\nDonor: ${record.donorName}\nHospital: ${record.hospitalName}\nBlood Group: ${record.bloodGroup}\nDate: ${new Date(record.date).toDateString()}`,
        createdAt: new Date()
      };

      await query(
        `INSERT INTO certificates
         (id, donation_id, donor_id, donor_name, hospital_name, blood_group, date, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          certificate.id,
          certificate.donationId,
          certificate.donorId,
          certificate.donorName,
          certificate.hospitalName,
          certificate.bloodGroup,
          certificate.date,
          certificate.content,
          certificate.createdAt
        ]
      );

      await createNotification({
        type: 'donation-confirmation',
        target: donor.name,
        targetId: donor.id,
        title: 'Donation confirmed',
        message: `${donor.name} donation confirmed for ${record.hospitalName}`,
        status: 'created',
        metadata: { donationId: record.id, requestId: request ? request.id : null, certificateId: certificate.id }
      });

      return sendJson(res, 200, {
        success: true,
        donation: normalizeDonationRecord(record),
        certificate: normalizeCertificateRecord(certificate),
        appointment: buildAppointmentSummary(appointment)
      });
    }

    if (method === 'GET' && pathname === '/appointments') {
      const donorId = toNumber(parsedUrl.query.donorId);
      const requestId = toNumber(parsedUrl.query.requestId);
      const hospitalName = String(parsedUrl.query.hospitalName || '').trim().toLowerCase();
      let sql = `
        SELECT id, hospital_name AS hospitalName, request_id AS requestId, donor_id AS donorId,
               blood_group AS bloodGroup, slot, status, accepted_at AS acceptedAt,
               completed_at AS completedAt, created_at AS createdAt
        FROM appointments
        WHERE 1 = 1
      `;
      const params = [];
      if (donorId !== null) {
        sql += ' AND donor_id = ?';
        params.push(donorId);
      }
      if (requestId !== null) {
        sql += ' AND request_id = ?';
        params.push(requestId);
      }
      if (hospitalName) {
        sql += ' AND LOWER(hospital_name) = ?';
        params.push(hospitalName);
      }
      sql += ' ORDER BY slot ASC';
      const appointments = (await query(sql, params)).map(normalizeAppointmentRecord);
      return sendJson(res, 200, { appointments, total: appointments.length });
    }

    if (method === 'POST' && pathname === '/appointments/create') {
      const body = await readBody(req);
      const hospitalName = String(body.hospitalName || '').trim();
      const slot = body.slot ? new Date(body.slot) : null;
      if (!hospitalName) return sendJson(res, 400, { error: 'Hospital name is required' });
      if (!slot || Number.isNaN(slot.getTime())) return sendJson(res, 400, { error: 'Valid slot is required' });

      const appointment = {
        id: createId(),
        hospitalName,
        requestId: body.requestId ? Number(body.requestId) : null,
        donorId: body.donorId ? Number(body.donorId) : null,
        bloodGroup: normalizeBloodGroup(body.bloodGroup),
        slot,
        status: body.donorId ? 'Assigned' : 'Open',
        createdAt: new Date(),
        acceptedAt: null,
        completedAt: null
      };

      await query(
        `INSERT INTO appointments
         (id, hospital_name, request_id, donor_id, blood_group, slot, status, accepted_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          appointment.id,
          appointment.hospitalName,
          appointment.requestId,
          appointment.donorId,
          appointment.bloodGroup,
          appointment.slot,
          appointment.status,
          null,
          null,
          appointment.createdAt
        ]
      );

      return sendJson(res, 200, { success: true, appointment: normalizeAppointmentRecord(appointment) });
    }

    if (method === 'POST' && pathname === '/appointments/select') {
      const body = await readBody(req);
      const appointmentId = Number(body.appointmentId);
      const donorId = Number(body.donorId);
      const appointment = await getAppointmentById(appointmentId);
      const donor = await getDonorById(donorId);
      if (!appointment) return sendJson(res, 404, { error: 'Appointment not found' });
      if (!donor) return sendJson(res, 404, { error: 'Donor not found' });
      if (!donor.eligibility.eligible) return sendJson(res, 400, { error: donor.eligibility.reason });

      await query(
        `UPDATE appointments SET donor_id = ?, status = 'Accepted', accepted_at = ? WHERE id = ?`,
        [donorId, new Date(), appointmentId]
      );

      const updated = await getAppointmentById(appointmentId);
      return sendJson(res, 200, {
        success: true,
        appointment: updated,
        donor: { id: donor.id, name: donor.name, bloodGroup: donor.bloodGroup }
      });
    }

    if (method === 'POST' && pathname === '/inventory/update') {
      const body = await readBody(req);
      const hospitalName = String(body.hospitalName || '').trim();
      const bloodGroup = normalizeBloodGroup(body.bloodGroup);
      if (!hospitalName) return sendJson(res, 400, { error: 'Hospital name is required' });
      if (!bloodGroup) return sendJson(res, 400, { error: 'Blood group is required' });

      const threshold = toNumber(body.threshold) || DEFAULT_INVENTORY_THRESHOLD;
      const unitsAvailable = toNumber(body.unitsAvailable);
      const existingRows = await query(
        `SELECT id FROM inventory WHERE LOWER(hospital_name) = ? AND blood_group = ? LIMIT 1`,
        [hospitalName.toLowerCase(), bloodGroup]
      );

      const record = {
        id: existingRows.length ? Number(existingRows[0].id) : createId(),
        hospitalName,
        bloodGroup,
        unitsAvailable: unitsAvailable === null ? 0 : unitsAvailable,
        threshold,
        updatedAt: new Date()
      };

      if (existingRows.length) {
        await query(
          `UPDATE inventory
           SET units_available = ?, threshold_units = ?, updated_at = ?
           WHERE id = ?`,
          [record.unitsAvailable, record.threshold, record.updatedAt, record.id]
        );
      } else {
        await query(
          `INSERT INTO inventory
           (id, hospital_name, blood_group, units_available, threshold_units, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [record.id, record.hospitalName, record.bloodGroup, record.unitsAvailable, record.threshold, record.updatedAt]
        );
      }

      let autoRequest = null;
      let alert = false;
      if (record.unitsAvailable <= record.threshold) {
        alert = true;
        await createNotification({
          type: 'inventory-alert',
          target: hospitalName,
          title: 'Low blood inventory',
          message: `${hospitalName} inventory for ${bloodGroup} is below threshold`,
          status: 'created',
          metadata: { bloodGroup, unitsAvailable: record.unitsAvailable, threshold: record.threshold }
        });
        if (body.autoCreateRequest === true) {
          const { request, errors } = validateRequest({
            hospitalName,
            bloodGroup,
            units: Math.max(1, record.threshold - record.unitsAvailable),
            urgency: body.urgency || 'Urgent',
            department: body.department || 'Inventory',
            latitude: body.latitude,
            longitude: body.longitude,
            radiusKm: body.radiusKm || DEFAULT_RADIUS_KM
          });
          if (!errors.length) {
            const donors = (await getNearbyDonorsFromDb(
              request.latitude,
              request.longitude,
              request.bloodGroup,
              request.radiusKm,
              true,
              { exactMatchOnly: request.exactMatchOnly }
            )).filter((item) => item.eligible);
            autoRequest = await insertRequestRecord({ id: createId(), ...request }, donors);
          }
        }
      }

      return sendJson(res, 200, {
        success: true,
        inventory: normalizeInventoryRecord(record),
        alert,
        autoRequest
      });
    }

    if (method === 'GET' && pathname === '/inventory') {
      const hospitalName = String(parsedUrl.query.hospitalName || '').trim().toLowerCase();
      let sql = `
        SELECT id, hospital_name AS hospitalName, blood_group AS bloodGroup, units_available AS unitsAvailable,
               threshold_units AS threshold, updated_at AS updatedAt
        FROM inventory
      `;
      const params = [];
      if (hospitalName) {
        sql += ' WHERE LOWER(hospital_name) = ?';
        params.push(hospitalName);
      }
      sql += ' ORDER BY blood_group ASC';
      const inventory = (await query(sql, params)).map(normalizeInventoryRecord);
      return sendJson(res, 200, { inventory, total: inventory.length });
    }

    if (method === 'GET' && pathname === '/analytics') {
      return sendJson(res, 200, await getAnalytics());
    }

    if (method === 'GET' && pathname === '/smart-matching') {
      const lat = toNumber(parsedUrl.query.lat);
      const lon = toNumber(parsedUrl.query.lon);
      const bloodGroup = normalizeBloodGroup(parsedUrl.query.bloodGroup);
      const radius = toNumber(parsedUrl.query.radius) || DEFAULT_RADIUS_KM;
      if (lat === null || lon === null || !bloodGroup) {
        return sendJson(res, 400, { error: 'lat, lon and bloodGroup are required' });
      }
      const donors = await getNearbyDonorsFromDb(lat, lon, bloodGroup, radius, false);
      return sendJson(res, 200, { donors, total: donors.length, radiusKm: radius });
    }

    if (method === 'GET' && /^\/hospitals\/.+\/donations$/.test(pathname)) {
      const hospitalName = decodeURIComponent(pathname.match(/^\/hospitals\/(.+)\/donations$/)[1]).trim();
      const donations = (await query(
        `SELECT id, donor_id AS donorId, donor_name AS donorName, request_id AS requestId, hospital_name AS hospitalName,
                blood_group AS bloodGroup, date, confirmed_at AS confirmedAt
         FROM donations
         WHERE LOWER(hospital_name) = ?
         ORDER BY date DESC`,
        [hospitalName.toLowerCase()]
      )).map(normalizeDonationRecord);
      return sendJson(res, 200, { hospitalName, donations, total: donations.length });
    }

    return sendJson(res, 404, { error: 'Route not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, async () => {
  console.log(`BDM backend running at http://localhost:${PORT}`);
  try {
    const dbStatus = await testDatabaseConnection();
    console.log('MySQL connected:', dbStatus);
  } catch (error) {
    console.error('MySQL connection failed:', error.message);
  }
}).on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.log(`Port ${PORT} is already in use.`);
  else console.error(error);
});

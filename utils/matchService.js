function normalizeBloodGroup(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/-/g, '-')
    .replace(/–/g, '-')
    .replace(/\s+/g, '');
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const aLat = toNumber(lat1);
  const aLon = toNumber(lon1);
  const bLat = toNumber(lat2);
  const bLon = toNumber(lon2);
  if ([aLat, aLon, bLat, bLon].some((item) => item === null)) return null;

  const earthRadiusKm = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const part =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(part), Math.sqrt(1 - part));
}

const DONOR_COMPATIBILITY = {
  'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
  'O+': ['O+', 'A+', 'B+', 'AB+'],
  'A-': ['A-', 'A+', 'AB-', 'AB+'],
  'A+': ['A+', 'AB+'],
  'B-': ['B-', 'B+', 'AB-', 'AB+'],
  'B+': ['B+', 'AB+'],
  'AB-': ['AB-', 'AB+'],
  'AB+': ['AB+']
};

function donorCanHelp(donorBloodGroup, requestedBloodGroup) {
  const donorBlood = normalizeBloodGroup(donorBloodGroup);
  const requestBlood = normalizeBloodGroup(requestedBloodGroup);
  if (!donorBlood || !requestBlood) return false;
  return (DONOR_COMPATIBILITY[donorBlood] || []).includes(requestBlood);
}

function buildMatchedDonors(donors, options) {
  const {
    latitude,
    longitude,
    bloodGroup,
    radiusKm = 8,
    availabilityOnly = false
  } = options;

  const requestBlood = normalizeBloodGroup(bloodGroup);

  return donors
    .map((donor) => {
      const distance = haversineKm(latitude, longitude, donor.latitude, donor.longitude);
      return {
        ...donor,
        bloodGroup: normalizeBloodGroup(donor.bloodGroup),
        distanceKm: distance === null ? null : Number(distance.toFixed(2)),
        canDonate: donorCanHelp(donor.bloodGroup, requestBlood)
      };
    })
    .filter((donor) => donor.canDonate)
    .filter((donor) => donor.distanceKm !== null)
    .filter((donor) => donor.distanceKm <= radiusKm)
    .filter((donor) => (availabilityOnly ? donor.available === true : true))
    .sort((left, right) => {
      if (left.available !== right.available) {
        return left.available ? -1 : 1;
      }
      return left.distanceKm - right.distanceKm;
    });
}

module.exports = {
  normalizeBloodGroup,
  toNumber,
  haversineKm,
  donorCanHelp,
  buildMatchedDonors
};

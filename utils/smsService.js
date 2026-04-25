function buildSMSMessage(bloodGroup, hospitalName, urgency = 'Normal') {
  const prefix = urgency === 'Emergency' ? 'URGENT' : 'Blood Request';
  return `${prefix}: ${bloodGroup} blood needed at ${hospitalName || 'a nearby hospital'}. Please respond if available.`;
}

async function sendSMS(donors, message) {
  const list = Array.isArray(donors) ? donors : [];
  console.log('\n[SMS LOG]');
  list.forEach((donor) => {
    console.log(`To: ${donor.name} (${donor.phone || 'no-phone'}) -> ${message}`);
  });

  return list.map((donor) => ({
    donor: donor.name,
    phone: donor.phone || '',
    status: 'logged'
  }));
}

module.exports = {
  buildSMSMessage,
  sendSMS
};

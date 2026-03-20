// Allocated minutes per service type
// Used by job timer engine and assignment board
const SERVICE_TIMES = {
  'Wheel Balancing':              20,
  'Wheel Alignment':              20,
  'Front Tyre Change':            20,
  'Rear Tyre Change':             20,
  'Both Front Tyres':             30,
  'Both Rear Tyres':              30,
  'All 4 Tyres':                  50,
  'Single Tyre Change':           20,
  'Tyre Puncture Repair':         15,
  'Battery Replacement':          15,
  'Oil Change':                   30,
  'Full Vehicle Check':           40,
  'Light Truck Tyre Change':      30,
  'Heavy Vehicle Tyre':           45,
  'Tyre Rotation':                20,
  'Brake Inspection':             25,
  'Suspension Check':             30,
  'General Service':              60,
};

// Default if service name not found
const DEFAULT_ALLOCATED_MINS = 30;

// Pause reasons for staff portal
const PAUSE_REASONS = [
  'Fetching tyres/tools',
  'On break',
  'Waiting for parts',
  'Customer query',
  'Equipment issue',
  'Supervisor needed',
  'Other',
];

// Bay count per branch (adjust as needed)
const BRANCH_BAYS = {
  'Pannipitiya': 4,
  'Ratnapura':   2,
  'Kalawana':    2,
  'Nivithigala': 2,
};

// Staff statuses
const STAFF_STATUSES = ['active', 'on_break', 'off'];

function getAllocatedMins(serviceName) {
  if (!serviceName) return DEFAULT_ALLOCATED_MINS;
  const key = Object.keys(SERVICE_TIMES).find(
    k => k.toLowerCase() === serviceName.toLowerCase()
  );
  return key ? SERVICE_TIMES[key] : DEFAULT_ALLOCATED_MINS;
}

module.exports = {
  SERVICE_TIMES,
  DEFAULT_ALLOCATED_MINS,
  PAUSE_REASONS,
  BRANCH_BAYS,
  STAFF_STATUSES,
  getAllocatedMins,
};
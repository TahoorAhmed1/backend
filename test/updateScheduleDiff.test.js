const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scheduleDataChanged } = require('../utils/xlsxParsing');
const { normalizeScope } = require('../lib/rideplaing');

test('normalizeScope accepts vehicleIds and maps them through the rideSync scope contract', () => {
  const scope = normalizeScope({
    vehicleId: 'veh-1',
    vehicleIds: ['veh-2', 'veh-3'],
    skipNotifications: true,
  });

  assert.deepEqual(scope.vehicleIds, ['veh-1', 'veh-2', 'veh-3']);
  assert.equal(scope.skipNotifications, true);
});

test('scheduleDataChanged ignores unchanged field values and flags driver/route/time differences', () => {
  const existing = {
    shiftTiming: 'MORNING',
    driverId: 'driver-1',
    routeId: 'route-1',
    pickupTime: '08:00',
    officeArrivalTime: '08:30',
    dropTime: '17:00',
    offDay: 'SUN',
    monday: 'BOTH',
    tuesday: 'BOTH',
    wednesday: 'BOTH',
    thursday: 'BOTH',
    friday: 'BOTH',
    saturday: 'OFF',
    sunday: 'OFF',
  };

  const incoming = {
    shiftTiming: 'MORNING',
    driverId: 'driver-1',
    routeId: 'route-1',
    pickupTime: '08:00',
    officeArrivalTime: '08:30',
    dropTime: '17:00',
    offDay: 'SUN',
    monday: 'BOTH',
    tuesday: 'BOTH',
    wednesday: 'BOTH',
    thursday: 'BOTH',
    friday: 'BOTH',
    saturday: 'OFF',
    sunday: 'OFF',
  };

  assert.equal(scheduleDataChanged(existing, incoming), false);

  const changed = {
    ...incoming,
    shiftTiming: 'EVENING',
    driverId: 'driver-2',
    routeId: 'route-2',
    pickupTime: '07:00',
    officeArrivalTime: '07:30',
    dropTime: '16:30',
    offDay: 'MON',
    monday: 'OFF',
  };

  assert.equal(scheduleDataChanged(existing, changed), true);
});

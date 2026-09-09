const buildRideSearchWhere = (routeIds = [], driverIds = [], vehicleIds = []) => {
  const predicates = [];

  if (routeIds.length) {
    predicates.push({ routeId: { in: routeIds } });
  }

  if (driverIds.length) {
    predicates.push({ driverId: { in: driverIds } });
  }

  if (vehicleIds.length) {
    predicates.push({ vehicleId: { in: vehicleIds } });
  }

  return predicates.length
    ? { OR: predicates }
    : { id: { in: [] } };
};

module.exports = {
  buildRideSearchWhere,
};

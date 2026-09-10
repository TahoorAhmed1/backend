const compareTripsByOccupancy = (a, b, getOccupancy) => {
  const occupancyDifference = getOccupancy(a) - getOccupancy(b);
  if (occupancyDifference !== 0) return occupancyDifference;

  const aTripNumber = Number.isFinite(Number(a.tripNumber))
    ? Number(a.tripNumber)
    : Number.MAX_SAFE_INTEGER;
  const bTripNumber = Number.isFinite(Number(b.tripNumber))
    ? Number(b.tripNumber)
    : Number.MAX_SAFE_INTEGER;
  if (aTripNumber !== bTripNumber) return aTripNumber - bTripNumber;

  return String(a.id).localeCompare(String(b.id));
};

const sortTripsByOccupancy = (trips, getOccupancy) =>
  [...trips].sort((a, b) => compareTripsByOccupancy(a, b, getOccupancy));

const selectAvailableTrip = (trips, getOccupancy, getCapacity) =>
  sortTripsByOccupancy(trips, getOccupancy).find(
    (trip) => getOccupancy(trip) < getCapacity(trip),
  ) || null;

module.exports = { sortTripsByOccupancy, selectAvailableTrip };
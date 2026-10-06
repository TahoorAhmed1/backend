const { prisma } = require("../../../lib/prisma");
const { okResponse, badRequestResponse } = require("../../../constants/responses");

const globalSearch = async (req, res, next) => {
  try {
    const q = req.query.q ? req.query.q.trim() : "";

    if (!q || q.length < 2) {
      const response = badRequestResponse("Query parameter 'q' must be at least 2 characters.");
      return res.status(response.status.code).json(response);
    }

    const take = 5; // top 5 results per entity type

    const [employees, drivers, vehicles, routes, vendors, departments, areas] = await Promise.all([
      // Employees
      prisma.employee.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { employeeCode: { contains: q, mode: "insensitive" } },
            { cnic: { contains: q, mode: "insensitive" } },
            { contactNumber: { contains: q, mode: "insensitive" } },
            { designation: { contains: q, mode: "insensitive" } },
          ],
        },
        take,
        select: {
          id: true,
          employeeCode: true,
          name: true,
          designation: true,
          status: true,
          department: { select: { id: true, name: true } },
          area: { select: { id: true, name: true } },
        },
      }),

      // Drivers
      prisma.driver.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { cnic: { contains: q, mode: "insensitive" } },
            { licenseNumber: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
            { shiftLabel: { contains: q, mode: "insensitive" } },
          ],
        },
        take,
        select: {
          id: true,
          name: true,
          licenseNumber: true,
          phone: true,
          status: true,
          vendor: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
      }),

      // Vehicles
      prisma.vehicle.findMany({
        where: {
          OR: [
            { vehicleNumber: { contains: q, mode: "insensitive" } },
            { make: { contains: q, mode: "insensitive" } },
            { model: { contains: q, mode: "insensitive" } },
          ],
        },
        take,
        select: {
          id: true,
          vehicleNumber: true,
          type: true,
          make: true,
          model: true,
          capacity: true,
          status: true,
          driver: { select: { id: true, name: true } },
          vendor: { select: { id: true, name: true } },
        },
      }),

      // Routes
      prisma.route.findMany({
        where: {
          OR: [
            { routeCode: { contains: q, mode: "insensitive" } },
            { routeName: { contains: q, mode: "insensitive" } },
            { shiftTiming: { contains: q, mode: "insensitive" } },
          ],
        },
        take,
        select: {
          id: true,
          routeCode: true,
          routeName: true,
          officeLocation: true,
          serviceType: true,
          status: true,
          area: { select: { id: true, name: true } },
        },
      }),

      // Vendors
      prisma.vendor.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { shortName: { contains: q, mode: "insensitive" } },
            { contactPerson: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        },
        take,
        select: {
          id: true,
          name: true,
          shortName: true,
          contactPerson: true,
          phone: true,
          status: true,
        },
      }),

      // Departments
      prisma.department.findMany({
        where: {
          name: { contains: q, mode: "insensitive" },
        },
        take,
        select: {
          id: true,
          name: true,
          _count: { select: { employees: true } },
        },
      }),

      // Areas
      prisma.area.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
          ],
        },
        take,
        select: {
          id: true,
          name: true,
          city: true,
          _count: { select: { employees: true, subAreas: true, routes: true } },
        },
      }),
    ]);

    return res.status(200).json(
      okResponse({
        query: q,
        results: {
          employees,
          drivers,
          vehicles,
          routes,
          vendors,
          departments,
          areas,
        },
      })
    );
  } catch (error) {
    next(error);
  }
};

module.exports = {
  globalSearch,
};

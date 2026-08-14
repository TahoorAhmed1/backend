const { prisma } = require("../../lib/prisma");
const {
  badRequestResponse,
  createSuccessResponse,
  okResponse,
  unauthorizedResponse,
} = require("../../constants/responses");
const { comparePasswords, createToken } = require("../../services/auth.service");



const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email, },
    });

    if (!user || !user.passwordHash) {
      const response = badRequestResponse("Invalid email or password.");
      return res.status(response.status.code).json(response);
    }

    if (!user.isActive) {
      const response = unauthorizedResponse("Account is inactive.");
      return res.status(response.status.code).json(response);
    }

    const passwordMatch = await comparePasswords(password, user.passwordHash);
    if (!passwordMatch) {
      const response = badRequestResponse("Invalid email or password.");
      return res.status(response.status.code).json(response);
    }

    
    const token = createToken({ userId: user.id, role: user.role });

    const response = createSuccessResponse(
      { user: user, token },
      "Login successful.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMe = async (req, res, next) => {
  try {
    const { userId } = req.user;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      const response = badRequestResponse("User not found.");
      return res.status(response.status.code).json(response);
    }

    const response = okResponse(sanitizeUser(user));
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const userList = async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        role: "EMPLOYEE",
      },
    });

    const response = okResponse(users.map(sanitizeUser));
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  getMe,
  userList,
};
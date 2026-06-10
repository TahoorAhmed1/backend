const { prisma } = require("../../../lib/prisma");
const {
  badRequestResponse,
  createSuccessResponse,
  okResponse,
  unauthorizedResponse,
} = require("../../../constants/responses");
const {
  hashPassword,
  comparePasswords,
  createToken,
} = require("../../services/auth.service");

const register = async (req, res, next) => {
  try {
    const { email, password, name, userRole } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      const response = unauthorizedResponse("Email already registered.");
      return res.status(response.status.code).json(response);
    }

    const hashedPassword = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || null,
        userRole: userRole || "user",
      },
    });

    const token = createToken({ userId: user.id, userRole: user.userRole });

    const response = createSuccessResponse(
      { user, token },
      "User registered successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      const response = badRequestResponse("Invalid email or password.");
      return res.status(response.status.code).json(response);
    }

    const passwordMatch = await comparePasswords(password, user.password);
    if (!passwordMatch) {
      const response = badRequestResponse("Invalid email or password.");
      return res.status(response.status.code).json(response);
    }

    const token = createToken({ userId: user.id, userRole: user.userRole });

    const response = createSuccessResponse(
      { user, token },
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

    const response = okResponse(user);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};
const userList = async (req, res, next) => {
  try {
    const user = await prisma.user.findMany({
      where: {
        userRole: "user",
      },
    });

    const response = okResponse(user);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  getMe,
  userList,
};

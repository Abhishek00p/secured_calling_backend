const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../config/firebase');
const { JWT_SECRET } = require('../config/env');
const { logger } = require('../middlewares/logging.middleware');

/**
 * Helper function to generate JWT token
 */
const generateToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

/**
 * Helper function to hash password
 */
const hashPassword = async (password) => {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
};

/**
 * Helper function to verify password
 */
const verifyPassword = async (password, hashedPassword) => {
  return bcrypt.compare(password, hashedPassword);
};

/**
 * User Login
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    logger.info('Attempting login for:', { email });

    // Find user in Firestore
    const usersRef = db.collection('users');
    const userQuery = await usersRef.where('email', '==', email).get();

    if (userQuery.empty) {
      return res.status(404).json({
        success: false,
        error_message: 'User not found'
      });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    // Check if hashedPassword exists
    if (!userData.hashedPassword) {
      return res.status(400).json({
        success: false,
        error_message: 'User password not properly configured'
      });
    }

    // Verify password
    const isPasswordValid = await verifyPassword(password, userData.hashedPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error_message: 'Invalid password'
      });
    }

    // Check if user is active
    if (userData.isActive === false) {
      return res.status(401).json({
        success: false,
        error_message: 'User account is inactive'
      });
    }

    // Generate token
    const token = generateToken(userDoc.id, userData.isAdmin ? 'admin' : (userData.isMember ? 'member' : 'user'));
    const data = {
      token,
      user: {
        userId: userData.userId,
        email: userData.email,
        name: userData.name,
        isAdmin: userData.isAdmin || false,
        isMember: userData.isMember || false,
        memberCode: userData.memberCode
      }
    };
    logger.info("the data which will be sent for login  : ", userData);
    res.status(200).json({
      success: true,
      data: data,
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to login'
    });
  }
};
function generate7DigitId() {
  return Math.floor(1000000 + Math.random() * 9999997); // 1000000 to 9999999
}
async function generateUniqueUserId() {
  let uniqueId;
  let docExists = true;

  while (docExists) {
    uniqueId = generate7DigitId();
    const docRef = db.collection('users').doc(uniqueId.toString());
    const docSnap = await docRef.get();
    docExists = docSnap.exists; // true if ID already exists
  }

  return uniqueId;
}

function getPlanInfo(expiryDate, planDays) {

  // Determine plan type
  let plan = "Silver";

  if (planDays > 180) {
    plan = "Premium";
  } else if (planDays > 60) {
    plan = "Gold";
  }

  return {
    expiryDate: expiryDate.toISOString(),
    plan: plan
  };
}

/**
 * Create User
 */
exports.createUser = async (req, res) => {
  try {
    const { email, password, name, isAdmin, isMember, memberCode, purchaseDate, planDays, maxParticipantsAllowed } = req.body;

    // Check if user already exists
    const existingUser = await db.collection('users')
      .where('email', '==', email)
      .get();

    if (!existingUser.empty) {
      return res.status(400).json({
        success: false,
        error_message: 'User already exists'
      });
    }

    // Hash password
    const hashedPassword = await hashPassword(password);
    const newUserId = await generateUniqueUserId();
    const expiryDate = new Date(purchaseDate);
    expiryDate.setDate(expiryDate.getDate() + planDays);
    const subscription = getPlanInfo(expiryDate, planDays);
    // Create user document
    const userDoc = await db.collection('users').doc(newUserId.toString()).set({
      email,
      name,
      hashedPassword,
      password: password,
      isAdmin: isAdmin || false,
      isMember: isMember || false,
      memberCode: memberCode || null,
      isActive: true,
      createdAt: new Date().toISOString(),
      planDays: planDays,
      maxParticipantsAllowed: maxParticipantsAllowed,
      purchaseDate: purchaseDate,
      userId: newUserId,
      subscription: subscription,
      planExpiryDate: expiryDate.toISOString()
    });

    res.status(201).json({
      success: true,
      data: {
        userId: userDoc.id,
        email,
        name,
        isAdmin: isAdmin || false,
        isMember: isMember || false,
        memberCode,
        planDays
      }
    });
  } catch (error) {
    logger.error('Create user error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to create user'
    });
  }
};

/**
 * Member creates a new user under same member
 */
exports.createUserUnderMember = async (req, res) => {
  try {
    const { name, email, password, memberUserId } = req.body;

    // 2️⃣ Fetch member details
    const memberSnap = await db
      .collection("users")
      .doc(memberUserId.toString())
      .get();

    if (!memberSnap.exists) {
      return res.status(404).json({
        success: false,
        error_message: "Member not found"
      });
    }

    const memberData = memberSnap.data();

    if (memberData.isMember !== true) {
      return res.status(400).json({
        success: false,
        error_message: "Provided user is not a member"
      });
    }

    // 3️⃣ Check if email already exists
    const existingUser = await db
      .collection("users")
      .where("email", "==", email)
      .get();

    if (!existingUser.empty) {
      return res.status(400).json({
        success: false,
        error_message: "User with this email already exists"
      });
    }

    // 4️⃣ Hash password
    const hashedPassword = await hashPassword(password);
    const newUserId = await generateUniqueUserId();

    // 5️⃣ Create user with inherited fields
    await db.collection("users").doc(newUserId.toString()).set({
      userId: newUserId,
      email,
      name,
      hashedPassword,
      password, // ⚠️ remove in production
      isAdmin: false,
      isMember: false,
      memberCode: memberData.memberCode,
      isActive: true,

      // inherited from member
      planDays: memberData.planDays,
      purchaseDate: memberData.purchaseDate,
      planExpiryDate: memberData.planExpiryDate,
      subscription: memberData.subscription,
      maxParticipantsAllowed: memberData.maxParticipantsAllowed,

      // tracking
      createdByMemberId: memberUserId,
      createdAt: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      data: {
        userId: newUserId,
        email,
        name,
        memberCode: memberData.memberCode,
        createdBy: memberUserId
      }
    });

  } catch (error) {
    logger.error("Create user under member error:", error);
    res.status(500).json({
      success: false,
      error_message: `Failed to create user under member : ${error}`
    });
  }
};

/**
 * Reset Password
 */
exports.resetPassword = async (req, res) => {
  try {
    const { userId, newPassword } = req.body;

    // Get user document
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'User not found'
      });
    }

    // Hash new password
    const hashedPassword = await hashPassword(newPassword);

    // Update password
    await userDoc.ref.update({
      hashedPassword,
      updatedAt: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    logger.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to reset password'
    });
  }
};

/**
 * Get User Credentials
 */
exports.getUserCredentials = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "user id required",
      });
    }
    const userDoc = await db.collection('users').doc(userId.toString()).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'User not found'
      });
    }

    const userData = userDoc.data();

    res.status(200).json({
      success: true,
      data: {
        userId: userDoc.id,
        email: userData.email,
        password: userData.password,
        name: userData.name,
        isAdmin: userData.isAdmin || false,
        isMember: userData.isMember || false,
        memberCode: userData.memberCode
      }
    });
  } catch (error) {
    logger.error('Get user credentials error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to get user credentials'
    });
  }
};

/**
 * Get Users for Password Reset
 */
exports.getUsersForPasswordReset = async (req, res) => {
  try {
    const { currentUserId } = req.params;

    // Get current user
    const currentUserDoc = await db.collection('users').doc(currentUserId).get();

    if (!currentUserDoc.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'Current user not found'
      });
    }

    const currentUserData = currentUserDoc.data();
    let users = [];

    if (currentUserData.isAdmin) {
      // Admin can see all members
      const membersQuery = await db.collection('users')
        .where('isMember', '==', true)
        .get();

      users = membersQuery.docs.map(doc => ({
        userId: doc.id,
        name: doc.data().name || '',
        email: doc.data().email || '',
        memberCode: doc.data().memberCode || '',
        isMember: true
      }));
    } else if (currentUserData.isMember) {
      // Member can see users under their member code
      const usersQuery = await db.collection('users')
        .where('memberCode', '==', currentUserData.memberCode)
        .where('isMember', '==', false)
        .get();

      users = usersQuery.docs.map(doc => ({
        userId: doc.id,
        name: doc.data().name || '',
        email: doc.data().email || '',
        memberCode: doc.data().memberCode || '',
        isMember: false
      }));
    }

    res.status(200).json({
      success: true,
      data: users
    });
  } catch (error) {
    logger.error('Get users for password reset error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to get users'
    });
  }
};
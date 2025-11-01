@echo off
echo 🚀 Setting up Good4It Backend...

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js (v16 or higher) first.
    pause
    exit /b 1
)

echo ✅ Node.js version: 
node --version

REM Check if MongoDB is available (optional check)
mongod --version >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ MongoDB is available
) else (
    echo ⚠️  MongoDB not found. Make sure MongoDB is installed and running.
)

REM Install dependencies
echo 📦 Installing dependencies...
npm install

if %errorlevel% equ 0 (
    echo ✅ Dependencies installed successfully
) else (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

REM Check if .env file exists
if not exist .env (
    echo ⚠️  .env file not found. Creating from template...
    copy env.example .env
    echo 📝 Please update the .env file with your configuration
    echo    - MongoDB URI
    echo    - JWT Secret
    echo    - Google OAuth credentials
) else (
    echo ✅ .env file found
)

echo.
echo 🎉 Setup complete!
echo.
echo Next steps:
echo 1. Update .env file with your configuration
echo 2. Start MongoDB (if using local instance)
echo 3. Run 'npm run dev' to start the development server
echo 4. Visit http://localhost:5000/api/health to test the API
echo.
echo Happy coding! 🚀
pause

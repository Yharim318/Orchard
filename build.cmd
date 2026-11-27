@echo off
rem Builds Orchard on Windows: build\orchard.jar and the native build\orchard.exe.
rem Finds GraalVM (ORCHARD_GRAALVM_HOME from local.env, JAVA_HOME, PATH, or the usual install folders) and
rem the Visual Studio C++ tools automatically, so it can be run from any command prompt or by double-clicking.
rem   build.cmd          JAR + native executable
rem   build.cmd --jar    JAR only (run with: java -jar build\orchard.jar)
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---- machine-specific settings (local.env: NAME=value lines; real environment variables win) ----
if exist local.env (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("local.env") do if not defined %%A set "%%A=%%B"
)

rem ---- locate GraalVM -------------------------------------------------------
if defined ORCHARD_GRAALVM_HOME set "JAVA_HOME=%ORCHARD_GRAALVM_HOME%"
if not defined JAVA_HOME (
  for /d %%G in ("%ProgramFiles%\Java\graalvm-*" "%ProgramFiles%\GraalVM\*" "%USERPROFILE%\.jdks\graalvm-*") do (
    if exist "%%~G\bin\native-image.cmd" set "JAVA_HOME=%%~G"
  )
)
if defined JAVA_HOME set "PATH=%JAVA_HOME%\bin;%PATH%"
where javac >nul 2>nul || (echo Could not find GraalVM. Set ORCHARD_GRAALVM_HOME in local.env ^(see local.env.example^) or JAVA_HOME to your GraalVM folder and try again. & goto :fail)
echo Using Java from %JAVA_HOME%

rem ---- compile --------------------------------------------------------------
if exist build\classes rmdir /s /q build\classes
mkdir build\classes
echo ==^> Compiling
dir /s /b src\main\java\*.java > build\sources.txt
javac --release 21 -encoding UTF-8 -d build\classes @build\sources.txt || goto :fail
xcopy /e /i /q /y src\main\resources build\classes >nul
jar --create --file build\orchard.jar --main-class orchard.Main -C build\classes . || goto :fail
echo     build\orchard.jar
if "%~1"=="--jar" goto :done

rem ---- Visual Studio C++ tools (needed by native-image) ---------------------
where cl >nul 2>nul
if errorlevel 1 (
  set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
  if exist "!VSWHERE!" (
    for /f "usebackq delims=" %%V in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%V"
  )
  if not defined VSDIR (echo Visual Studio C++ build tools not found. Install "Desktop development with C++" or run: build.cmd --jar & goto :fail)
  call "!VSDIR!\VC\Auxiliary\Build\vcvars64.bat" >nul || goto :fail
)

rem ---- native image ---------------------------------------------------------
echo ==^> Building native executable (takes a minute or two)
call native-image -march=compatibility -jar build\orchard.jar -o build\orchard || goto :fail
rem Mark the exe as a windowed program so Windows doesn't open a terminal for it. Its log goes to
rem %LOCALAPPDATA%\Orchard\orchard.log; Ctrl+Shift+T in the Orchard window shows it.
editbin /nologo /subsystem:windows build\orchard.exe || goto :fail
echo     build\orchard.exe
echo.
echo Done. Start Orchard with:  build\orchard.exe

:done
endlocal
if not defined CI echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause
exit /b 0

:fail
echo.
echo Build failed.
endlocal
if not defined CI echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause
exit /b 1

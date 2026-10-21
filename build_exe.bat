@echo off
title Compilation du lanceur de caisse

:: -- Se placer dans le dossier du .bat lui-meme --
cd /d "%~dp0"

echo.
echo  === Compilation du lanceur en .exe ===
echo  Dossier : %CD%
echo.

:: -- Verifier Python --
where python >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python n'est pas installe ou pas dans le PATH.
    pause
    exit /b 1
)
echo [OK] Python detecte.

:: -- Installer PyInstaller --
echo.
echo [1/3] Installation de PyInstaller...
python -m pip install pyinstaller --quiet --disable-pip-version-check
echo [OK] PyInstaller pret.

:: -- Compiler --
echo.
echo [2/3] Compilation en cours (peut prendre 30-60 secondes)...
echo.

python -m PyInstaller --onefile --windowed --name "LanceurCaisse" "%~dp0lance_caisse.py"

if errorlevel 1 (
    echo.
    echo [ERREUR] La compilation a echoue.
    pause
    exit /b 1
)

:: -- Copier le .exe a la racine --
echo.
echo [3/3] Deplacement du .exe...

if exist "dist\LanceurCaisse.exe" (
    copy /Y "dist\LanceurCaisse.exe" "%~dp0LanceurCaisse.exe" >nul
    echo.
    echo [OK] LanceurCaisse.exe est pret !
    echo Double-clic dessus pour tout lancer !
) else (
    echo [ERREUR] LanceurCaisse.exe introuvable dans dist\
)

echo.
pause

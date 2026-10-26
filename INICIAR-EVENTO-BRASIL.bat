@echo off
setlocal EnableExtensions
title Evento Brasil - Instalador e inicializacao
cd /d "%~dp0"

echo.
echo  ==========================================================
echo    EVENTO BRASIL - instalacao e inicializacao (desenvolvimento)
echo  ==========================================================
echo.

rem --- 1. Node.js ----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [ERRO] Node.js nao encontrado.
  echo         Instale o Node.js LTS ^(versao 20.19 ou mais nova^) em https://nodejs.org
  echo         e execute este arquivo novamente.
  goto :fail
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 (
  echo  [ERRO] Node.js muito antigo. Instale a versao LTS mais recente em https://nodejs.org
  goto :fail
)
for /f "delims=" %%v in ('node -v') do echo  [ok] Node.js %%v

rem --- 2. Arquivo .env -------------------------------------------------------
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  [ok] .env criado a partir de .env.example ^(valores de desenvolvimento^)
) else (
  echo  [ok] .env encontrado
)

rem --- 3. Dependencias -------------------------------------------------------
echo.
echo  [..] Instalando dependencias ^(a primeira vez pode levar alguns minutos^)...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo  [ERRO] Falha no npm install. Verifique a conexao com a internet.
  goto :fail
)
echo  [ok] Dependencias instaladas

rem --- 4. Banco de dados -----------------------------------------------------
echo.
echo  [..] Iniciando o banco de dados...
start "Evento Brasil - Banco de dados" /min cmd /k "npm run db:start"
node scripts\setup-helper.mjs wait-db
if errorlevel 1 (
  echo  [ERRO] O banco de dados nao respondeu. Veja a janela "Evento Brasil - Banco de dados".
  goto :fail
)
echo  [ok] Banco de dados ativo

call npx prisma migrate deploy
if errorlevel 1 (
  echo  [ERRO] Falha ao aplicar as migracoes do banco.
  goto :fail
)
echo  [ok] Estrutura do banco atualizada

rem Dados de demonstracao: somente na primeira instalacao (o seed apaga tudo).
node scripts\setup-helper.mjs needs-seed
if not errorlevel 1 (
  echo  [..] Carregando dados de demonstracao...
  call npx prisma db seed
  if errorlevel 1 (
    echo  [ERRO] Falha ao carregar os dados de demonstracao.
    goto :fail
  )
  echo  [ok] Dados de demonstracao carregados
) else (
  echo  [ok] Banco ja possui dados ^(seed ignorado^)
)

rem --- 5. Aplicacao ----------------------------------------------------------
echo.
echo  [..] Iniciando a aplicacao ^(janela "Evento Brasil - App"^)...
start "Evento Brasil - App" cmd /k "npm run dev"
node scripts\setup-helper.mjs wait-http http://localhost:3000
if errorlevel 1 (
  echo  [ERRO] A aplicacao nao respondeu em http://localhost:3000. Veja a janela "Evento Brasil - App".
  goto :fail
)
start "" http://localhost:3000

echo.
echo  ==========================================================
echo    PRONTO!  Abra: http://localhost:3000
echo.
echo    Contas de demonstracao (senha: Demo@2026!):
echo      cliente@demo.eventobrasil.test     - comprador
echo      produtora@demo.eventobrasil.test   - organizador
echo      admin@demo.eventobrasil.test       - administrador
echo.
echo    Para parar: feche a janela "Evento Brasil - App".
echo    Para abrir de novo: execute este arquivo novamente.
echo  ==========================================================
echo.
pause
exit /b 0

:fail
echo.
echo  A instalacao nao foi concluida. Corrija o problema acima e execute novamente.
echo.
pause
exit /b 1

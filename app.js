/**
 * ==========================================================================
 * PCP - SISTEMA DE GESTIÓN | CENTRO DE ESPECIALIDADES ANZOÁTEGUI
 * Lógica Principal del Sistema (app.js)
 * Base de Datos: SQLite (WebAssembly sql.js + Persistencia IndexedDB)
 * ==========================================================================
 */

(function () {
  'use strict';

  // --- Constantes de Configuración ---
  const DB_STORE_NAME = 'pcp_sqlite_store';
  const DB_RECORD_KEY = 'sqlite_db_binary';
  const JSONBIN_API = 'https://api.jsonbin.io/v3';

  // --- Estado de la Aplicación ---
  let SQL = null;
  let db = null;
  let currentUser = null;
  let currentTab = 'tickets';
  let activePriorityFilter = 'all';
  let chartInstances = {};
  let editingTicketId = null;
  let editImagenesEliminar = [];
  let isSyncing = false;
  let syncInterval = null;
  let currentTheme = localStorage.getItem('pcp_theme') || 'light';
  let JSONBIN_CONFIG = JSON.parse(localStorage.getItem('jsonbin_config')) || null;

  // ==========================================================================
  // CAPA DE BASE DE DATOS: SQLite (WebAssembly + IndexedDB)
  // ==========================================================================

  /**
   * Abre la base de datos IndexedDB para persistir los bytes de SQLite.
   */
  function abrirIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('PCPSQLiteDB', 1);
      request.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains(DB_STORE_NAME)) {
          idb.createObjectStore(DB_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Guarda los bytes binarios de la base de datos SQLite en IndexedDB.
   */
  async function persistirSQLite(bytes) {
    try {
      const idb = await abrirIndexedDB();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(DB_STORE_NAME, 'readwrite');
        const store = tx.objectStore(DB_STORE_NAME);
        store.put(bytes, DB_RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('Persistencia IndexedDB no disponible, usando respaldo:', err);
    }
  }

  /**
   * Recupera los bytes binarios de la base de datos SQLite guardada.
   */
  async function cargarSQLiteDeIndexedDB() {
    try {
      const idb = await abrirIndexedDB();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(DB_STORE_NAME, 'readonly');
        const store = tx.objectStore(DB_STORE_NAME);
        const req = store.get(DB_RECORD_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('Error al leer de IndexedDB:', err);
      return null;
    }
  }

  /**
   * Guarda el estado actual de la base de datos SQLite.
   */
  function guardarBD() {
    if (!db) return;
    try {
      const data = db.export();
      persistirSQLite(data);
    } catch (err) {
      console.error('Error al exportar SQLite:', err);
    }
  }

  /**
   * Inicializa la base de datos SQLite creando tablas e importando datos si existen.
   */
  async function inicializarSQLite() {
    actualizarEstadoBD('Iniciando SQLite WebAssembly...');
    try {
      if (typeof window.initSqlJs === 'function') {
        SQL = await window.initSqlJs({
          locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/${file}`
        });
      } else {
        throw new Error('Librería sql.js no disponible');
      }

      // Intentar cargar base de datos previa desde IndexedDB
      const datosGuardados = await cargarSQLiteDeIndexedDB();
      if (datosGuardados) {
        db = new SQL.Database(datosGuardados);
      } else {
        db = new SQL.Database();
      }

      // Crear el esquema relacional
      crearEsquemaTablas();

      // Migrar datos anteriores desde localStorage si existen y la BD está vacía
      migrarDesdeLocalStorage();

      actualizarEstadoBD('SQLite Activo (Memoria + IndexedDB)');
    } catch (err) {
      console.error('Fallo al inicializar SQLite:', err);
      actualizarEstadoBD('Modo de compatibilidad Local');
      inicializarFallbackLocalStorage();
    }
  }

  /**
   * Crea las tablas relacionales de la base de datos SQLite.
   */
  function crearEsquemaTablas() {
    if (!db) return;
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        nombreReal TEXT NOT NULL,
        email TEXT NOT NULL
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY,
        nombre TEXT NOT NULL,
        titulo TEXT NOT NULL,
        prioridad TEXT NOT NULL,
        descripcion TEXT NOT NULL,
        fecha TEXT NOT NULL,
        estado TEXT NOT NULL,
        gerenteEmisor TEXT NOT NULL,
        tecnicoAsignado TEXT NOT NULL,
        tecnicoUsername TEXT NOT NULL,
        resena TEXT DEFAULT '',
        fechaCierre TEXT DEFAULT '',
        ultimaModificacion TEXT DEFAULT ''
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS ticket_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        nombre TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Migra datos previos de localStorage a la base de datos SQLite.
   */
  function migrarDesdeLocalStorage() {
    if (!db) return;
    try {
      const resUsers = db.exec('SELECT COUNT(*) as total FROM users');
      const countUsers = resUsers[0] && resUsers[0].values[0] ? resUsers[0].values[0][0] : 0;

      if (countUsers === 0) {
        const oldUsers = JSON.parse(localStorage.getItem('usersDatabase')) || {};
        for (const [username, u] of Object.entries(oldUsers)) {
          db.run(
            'INSERT OR REPLACE INTO users (username, password, role, nombreReal, email) VALUES (?, ?, ?, ?, ?)',
            [username, u.password || '', u.role || 'tecnico', u.nombreReal || username, u.email || '']
          );
        }

        const oldTickets = JSON.parse(localStorage.getItem('tickets')) || [];
        for (const t of oldTickets) {
          db.run(
            `INSERT OR REPLACE INTO tickets (id, nombre, titulo, prioridad, descripcion, fecha, estado, gerenteEmisor, tecnicoAsignado, tecnicoUsername, resena, fechaCierre, ultimaModificacion)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              t.id, t.nombre || '', t.titulo || '', t.prioridad || 'baja', t.descripcion || '',
              t.fecha || '', t.estado || 'pendiente', t.gerenteEmisor || '', t.tecnicoAsignado || '',
              t.tecnicoUsername || '', t.resena || '', t.fechaCierre || '', t.ultimaModificacion || ''
            ]
          );

          if (Array.isArray(t.imagenes)) {
            for (const img of t.imagenes) {
              db.run(
                'INSERT INTO ticket_images (ticket_id, nombre, data) VALUES (?, ?, ?)',
                [t.id, img.nombre || 'Evidencia', img.data || '']
              );
            }
          }
        }
        guardarBD();
      }
    } catch (e) {
      console.warn('Error en migración inicial:', e);
    }
  }

  /**
   * Fallback de emergencia si SQLite WASM no puede ejecutarse.
   */
  function inicializarFallbackLocalStorage() {
    // Si SQLite no corre, emulamos la API de DB sobre localStorage
    window._pcp_use_localstorage_fallback = true;
  }

  function actualizarEstadoBD(texto) {
    const el = document.getElementById('sqlite-status-indicator');
    if (el) el.textContent = texto;
    const badge = document.getElementById('sqlite-nav-badge');
    if (badge) badge.textContent = texto.includes('Activo') ? 'SQLite' : 'Local';
  }

  // ==========================================================================
  // OPERACIONES CRUD EN SQLITE
  // ==========================================================================

  function getUsuariosSQLite() {
    if (!db) {
      return JSON.parse(localStorage.getItem('usersDatabase')) || {};
    }
    const stmt = db.prepare('SELECT username, password, role, nombreReal, email FROM users');
    const result = {};
    while (stmt.step()) {
      const row = stmt.getAsObject();
      result[row.username] = row;
    }
    stmt.free();
    return result;
  }

  function getUsuarioPorUsername(username) {
    if (!db) {
      const users = JSON.parse(localStorage.getItem('usersDatabase')) || {};
      return users[username] || null;
    }
    const stmt = db.prepare('SELECT username, password, role, nombreReal, email FROM users WHERE username = ?');
    stmt.bind([username]);
    let user = null;
    if (stmt.step()) {
      user = stmt.getAsObject();
    }
    stmt.free();
    return user;
  }

  function guardarUsuarioSQLite(username, password, role, nombreReal, email) {
    if (!db) {
      const users = JSON.parse(localStorage.getItem('usersDatabase')) || {};
      users[username] = { username, password, role, nombreReal, email };
      localStorage.setItem('usersDatabase', JSON.stringify(users));
      return;
    }
    db.run(
      'INSERT OR REPLACE INTO users (username, password, role, nombreReal, email) VALUES (?, ?, ?, ?, ?)',
      [username, password, role, nombreReal, email]
    );
    guardarBD();
  }

  function eliminarUsuarioSQLite(username) {
    if (!db) {
      const users = JSON.parse(localStorage.getItem('usersDatabase')) || {};
      delete users[username];
      localStorage.setItem('usersDatabase', JSON.stringify(users));
      return;
    }
    db.run('DELETE FROM users WHERE username = ?', [username]);
    guardarBD();
  }

  function actualizarContrasenaSQLite(username, newPassword) {
    if (!db) {
      const users = JSON.parse(localStorage.getItem('usersDatabase')) || {};
      if (users[username]) users[username].password = newPassword;
      localStorage.setItem('usersDatabase', JSON.stringify(users));
      return;
    }
    db.run('UPDATE users SET password = ? WHERE username = ?', [newPassword, username]);
    guardarBD();
  }

  function getTicketsSQLite() {
    if (!db) {
      return JSON.parse(localStorage.getItem('tickets')) || [];
    }
    const ticketsStmt = db.prepare(`
      SELECT id, nombre, titulo, prioridad, descripcion, fecha, estado, 
             gerenteEmisor, tecnicoAsignado, tecnicoUsername, resena, fechaCierre, ultimaModificacion
      FROM tickets ORDER BY id DESC
    `);
    const tickets = [];
    while (ticketsStmt.step()) {
      const t = ticketsStmt.getAsObject();
      t.imagenes = [];
      tickets.push(t);
    }
    ticketsStmt.free();

    // Obtener imágenes correspondientes
    const imgStmt = db.prepare('SELECT id, ticket_id, nombre, data FROM ticket_images ORDER BY id ASC');
    while (imgStmt.step()) {
      const img = imgStmt.getAsObject();
      const ticket = tickets.find((tk) => tk.id === img.ticket_id);
      if (ticket) {
        ticket.imagenes.push({ id: img.id, nombre: img.nombre, data: img.data });
      }
    }
    imgStmt.free();

    return tickets;
  }

  function insertarTicketSQLite(ticket) {
    if (!db) {
      const tickets = JSON.parse(localStorage.getItem('tickets')) || [];
      tickets.push(ticket);
      localStorage.setItem('tickets', JSON.stringify(tickets));
      return;
    }
    db.run(
      `INSERT INTO tickets (id, nombre, titulo, prioridad, descripcion, fecha, estado, gerenteEmisor, tecnicoAsignado, tecnicoUsername, resena, fechaCierre, ultimaModificacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ticket.id, ticket.nombre, ticket.titulo, ticket.prioridad, ticket.descripcion,
        ticket.fecha, ticket.estado, ticket.gerenteEmisor, ticket.tecnicoAsignado,
        ticket.tecnicoUsername, ticket.resena || '', ticket.fechaCierre || '', ticket.ultimaModificacion || ''
      ]
    );

    if (Array.isArray(ticket.imagenes)) {
      for (const img of ticket.imagenes) {
        db.run(
          'INSERT INTO ticket_images (ticket_id, nombre, data) VALUES (?, ?, ?)',
          [ticket.id, img.nombre, img.data]
        );
      }
    }
    guardarBD();
  }

  function actualizarEstadoTicketSQLite(id, estado) {
    if (!db) {
      const tickets = JSON.parse(localStorage.getItem('tickets')) || [];
      const t = tickets.find(item => item.id === id);
      if (t) { t.estado = estado; localStorage.setItem('tickets', JSON.stringify(tickets)); }
      return;
    }
    db.run('UPDATE tickets SET estado = ? WHERE id = ?', [estado, id]);
    guardarBD();
  }

  function finalizarTicketSQLite(id, resena, fechaCierre, imagenesNuevas) {
    if (!db) {
      const tickets = JSON.parse(localStorage.getItem('tickets')) || [];
      const t = tickets.find(item => item.id === id);
      if (t) {
        t.estado = 'terminado';
        t.resena = resena;
        t.fechaCierre = fechaCierre;
        t.imagenes = imagenesNuevas;
        localStorage.setItem('tickets', JSON.stringify(tickets));
      }
      return;
    }

    db.run('UPDATE tickets SET estado = ?, resena = ?, fechaCierre = ? WHERE id = ?', ['terminado', resena, fechaCierre, id]);
    if (Array.isArray(imagenesNuevas)) {
      for (const img of imagenesNuevas) {
        db.run('INSERT INTO ticket_images (ticket_id, nombre, data) VALUES (?, ?, ?)', [id, img.nombre, img.data]);
      }
    }
    guardarBD();
  }

  function actualizarEdicionTicketSQLite(id, resena, imagenesMantener, imagenesNuevas) {
    if (!db) {
      const tickets = JSON.parse(localStorage.getItem('tickets')) || [];
      const t = tickets.find(item => item.id === id);
      if (t) {
        t.resena = resena;
        t.imagenes = [...imagenesMantener, ...imagenesNuevas];
        t.ultimaModificacion = new Date().toISOString();
        localStorage.setItem('tickets', JSON.stringify(tickets));
      }
      return;
    }

    const modFecha = new Date().toISOString();
    db.run('UPDATE tickets SET resena = ?, ultimaModificacion = ? WHERE id = ?', [resena, modFecha, id]);

    // Eliminar todas las imágenes anteriores y reinsertar las finales
    db.run('DELETE FROM ticket_images WHERE ticket_id = ?', [id]);
    const todasImagenes = [...imagenesMantener, ...imagenesNuevas];
    for (const img of todasImagenes) {
      db.run('INSERT INTO ticket_images (ticket_id, nombre, data) VALUES (?, ?, ?)', [id, img.nombre, img.data]);
    }
    guardarBD();
  }

  // ==========================================================================
  // EXPORTACIÓN / IMPORTACIÓN DE BASE DE DATOS SQLITE (.db)
  // ==========================================================================

  function exportarBaseDatosSQLite() {
    if (!db) {
      alert('La base de datos SQLite no está disponible para exportar.');
      return;
    }
    try {
      const data = db.export();
      const blob = new Blob([data], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pcp_database_' + new Date().toISOString().split('T')[0] + '.db';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Error al exportar archivo SQLite: ' + err.message);
    }
  }

  function importarBaseDatosSQLite(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!confirm('¿Deseas reemplazar la base de datos actual con este archivo SQLite (.db)? Se perderán los datos no guardados.')) {
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const u8arr = new Uint8Array(e.target.result);
        db = new SQL.Database(u8arr);
        await persistirSQLite(u8arr);
        actualizarEstadoBD('SQLite Activo (Base de Datos Cargada)');
        alert('¡Base de datos SQLite importada exitosamente!');
        if (currentUser) {
          actualizarListaDesplegableTecnicos();
          renderTickets();
          renderUsuariosTable();
          actualizarSidebarStats();
        } else {
          checkSystemSetup();
        }
      } catch (err) {
        alert('Error al cargar archivo SQLite: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = '';
  }

  async function borrarBaseDatosCompleta() {
    const confirmacion = prompt(
      'ADVERTENCIA CRÍTICA:\n' +
      'Esta acción eliminará de forma irreversible toda la base de datos (tickets, fotos, usuarios y configuraciones).\n\n' +
      'Para confirmar, escribe exactamente la palabra "BORRAR" (en mayúsculas):'
    );

    if (confirmacion !== 'BORRAR') {
      if (confirmacion !== null) {
        alert('Acción cancelada. La palabra ingresada no coincide.');
      }
      return;
    }

    try {
      // 1. Limpiar almacén de IndexedDB
      const idb = await abrirIndexedDB();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction(DB_STORE_NAME, 'readwrite');
        const store = tx.objectStore(DB_STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      // 2. Limpiar residuos en localStorage
      localStorage.removeItem('usersDatabase');
      localStorage.removeItem('tickets');

      // 3. Reiniciar instancia de SQLite en memoria y recrear tablas limpias
      if (SQL) {
        db = new SQL.Database();
        crearEsquemaTablas();
      }

      actualizarEstadoBD('SQLite Activo (Base de Datos Vacía)');
      alert('¡Base de datos eliminada por completo! El sistema volverá a la pantalla de configuración inicial.');
      
      // 4. Cerrar sesión y mostrar pantalla de configuración inicial
      logout();
    } catch (err) {
      alert('Error al borrar la base de datos: ' + err.message);
    }
  }

  // ==========================================================================
  // TEMA VISUAL (CLARO / OSCURO)
  // ==========================================================================

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme);
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
      if (currentTheme === 'dark') {
        btn.classList.add('on');
        btn.title = 'Modo claro';
      } else {
        btn.classList.remove('on');
        btn.title = 'Modo oscuro';
      }
    }
  }

  function toggleTheme() {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    localStorage.setItem('pcp_theme', currentTheme);
    applyTheme();
    if (currentTab === 'dashboard') initDashboards();
  }

  // ==========================================================================
  // AUTENTICACIÓN Y ROLES
  // ==========================================================================

  function checkSystemSetup() {
    const users = getUsuariosSQLite();
    const hasUsers = Object.keys(users).length > 0;
    const loginBox = document.getElementById('login-box');
    const setupBox = document.getElementById('setup-box');

    if (!hasUsers) {
      if (loginBox) loginBox.style.display = 'none';
      if (setupBox) setupBox.style.display = 'block';
    } else {
      if (loginBox) loginBox.style.display = 'block';
      if (setupBox) setupBox.style.display = 'none';
    }
  }

  function handleInitialSetup(e) {
    e.preventDefault();
    const fullname = document.getElementById('setup-fullname').value.trim();
    const email = document.getElementById('setup-email').value.trim();
    const username = document.getElementById('setup-username').value.trim().toLowerCase();
    const password = document.getElementById('setup-password').value;

    if (!fullname || !email || !username || !password) return;

    guardarUsuarioSQLite(username, password, 'gerente', fullname, email);
    sincronizarNube();
    alert('¡Gerente registrado! Inicia sesión con tus credenciales.');
    checkSystemSetup();
  }

  function handleLogin(e) {
    e.preventDefault();
    const userIn = document.getElementById('login-username').value.trim().toLowerCase();
    const passIn = document.getElementById('login-password').value;
    const user = getUsuarioPorUsername(userIn);

    if (user && user.password === passIn) {
      currentUser = { ...user };

      document.getElementById('view-login').style.display = 'none';
      document.getElementById('app-main').style.display = 'flex';

      document.getElementById('user-name-display').textContent = currentUser.nombreReal;
      document.getElementById('user-role-display').textContent =
        currentUser.role === 'gerente' ? 'Supervisor PCP' : 'Inspector PCP';
      document.getElementById('user-avatar').textContent = currentUser.nombreReal.charAt(0).toUpperCase();

      // Ajustes según el rol
      const navDashboard = document.getElementById('nav-dashboard');
      const navUsuarios = document.getElementById('nav-usuarios');
      const navNube = document.getElementById('nav-nube');
      const btnAbrirModalTicket = document.getElementById('btn-abrir-modal-ticket');

      if (currentUser.role === 'tecnico') {
        if (navDashboard) navDashboard.style.display = 'none';
        if (navUsuarios) navUsuarios.style.display = 'none';
        if (navNube) navNube.style.display = 'none';
        if (btnAbrirModalTicket) btnAbrirModalTicket.style.display = 'none';
      } else {
        if (navDashboard) navDashboard.style.display = 'flex';
        if (navUsuarios) navUsuarios.style.display = 'flex';
        if (navNube) navNube.style.display = 'flex';
        if (btnAbrirModalTicket) btnAbrirModalTicket.style.display = 'inline-flex';
        actualizarListaDesplegableTecnicos();
      }

      activePriorityFilter = 'all';
      const filterAlert = document.getElementById('filter-alert');
      if (filterAlert) filterAlert.style.display = 'none';

      iniciarSincronizacionAutomatica();
      switchTab('tickets');
      actualizarSidebarStats();
    } else {
      alert('Acceso Denegado: Usuario o contraseña erróneos.');
    }
  }

  function logout() {
    currentUser = null;
    editingTicketId = null;
    detenerSincronizacionAutomatica();
    mostrarSyncIndicator(null);
    document.getElementById('view-login').style.display = 'flex';
    document.getElementById('app-main').style.display = 'none';
    checkSystemSetup();
  }

  function handlePasswordChange(e) {
    e.preventDefault();
    const oldPass = document.getElementById('profile-old-password').value;
    const newPass = document.getElementById('profile-new-password').value;
    const confirmPass = document.getElementById('profile-confirm-password').value;

    const user = getUsuarioPorUsername(currentUser.username);
    if (!user || user.password !== oldPass) {
      alert('La contraseña actual es incorrecta.');
      return;
    }
    if (newPass.length < 4) {
      alert('La nueva contraseña debe tener mínimo 4 caracteres.');
      return;
    }
    if (newPass !== confirmPass) {
      alert('Las contraseñas no coinciden.');
      return;
    }

    actualizarContrasenaSQLite(currentUser.username, newPass);
    currentUser.password = newPass;
    sincronizarNube();
    alert('¡Contraseña actualizada con éxito!');
    document.getElementById('profile-old-password').value = '';
    document.getElementById('profile-new-password').value = '';
    document.getElementById('profile-confirm-password').value = '';
    switchTab('tickets');
  }

  // ==========================================================================
  // NAVEGACIÓN POR PESTAÑAS
  // ==========================================================================

  function switchTab(tab) {
    if ((tab === 'dashboard' || tab === 'usuarios' || tab === 'nube') && currentUser.role !== 'gerente') return;
    currentTab = tab;
    editingTicketId = null;

    document.querySelectorAll('.sidebar-item').forEach((btn) => {
      btn.classList.remove('active');
      if (btn.getAttribute('data-tab') === tab) btn.classList.add('active');
    });

    const tabs = ['tickets', 'dashboard', 'usuarios', 'nube', 'perfil'];
    tabs.forEach((t) => {
      const el = document.getElementById('tab-' + t);
      if (el) el.style.display = 'none';
    });

    const activeEl = document.getElementById('tab-' + tab);
    if (activeEl) {
      activeEl.style.display = (tab === 'dashboard' || tab === 'tickets') ? 'flex' : 'block';
    }

    if (tab === 'tickets') renderTickets();
    else if (tab === 'dashboard') initDashboards();
    else if (tab === 'usuarios') renderUsuariosTable();
    else if (tab === 'nube') {
      if (JSONBIN_CONFIG) {
        document.getElementById('jsonbin-master-key').value = JSONBIN_CONFIG.masterKey || '';
        document.getElementById('jsonbin-bin-id').value = JSONBIN_CONFIG.binId || '';
      }
    }
  }

  // ==========================================================================
  // GESTIÓN DE PERSONAL / USUARIOS
  // ==========================================================================

  function actualizarListaDesplegableTecnicos() {
    const select = document.getElementById('ticket-asignado');
    if (!select) return;
    select.innerHTML = '<option value="">-- Seleccionar Inspector --</option>';
    const users = getUsuariosSQLite();
    Object.values(users).forEach((u) => {
      if (u.role === 'tecnico') {
        select.innerHTML += `<option value="${u.username}">${u.nombreReal}</option>`;
      }
    });
  }

  function registrarUsuario(e) {
    e.preventDefault();
    const fullname = document.getElementById('user-fullname').value.trim();
    const email = document.getElementById('user-email').value.trim();
    const username = document.getElementById('user-username').value.trim().toLowerCase();
    const password = document.getElementById('user-password').value;
    const role = document.getElementById('user-role').value;

    if (getUsuarioPorUsername(username)) {
      alert('El nombre de usuario ya existe.');
      return;
    }

    guardarUsuarioSQLite(username, password, role, fullname, email);
    sincronizarNube();
    document.getElementById('form-usuario').reset();
    renderUsuariosTable();
    actualizarListaDesplegableTecnicos();
    actualizarSidebarStats();
    alert('¡Usuario registrado exitosamente en la base de datos!');
  }

  function darDeBajaUsuario(username) {
    if (username === currentUser.username) {
      alert('No puedes darte de baja a ti mismo.');
      return;
    }
    if (confirm(`¿Dar de baja al usuario [${username}]?`)) {
      eliminarUsuarioSQLite(username);
      sincronizarNube();
      renderUsuariosTable();
      actualizarListaDesplegableTecnicos();
      actualizarSidebarStats();
    }
  }

  function renderUsuariosTable() {
    const tbody = document.getElementById('tabla-usuarios-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    const users = getUsuariosSQLite();

    Object.values(users).forEach((user) => {
      const boton =
        user.username === currentUser.username
          ? '<span style="font-size:11px;color:var(--muted);font-style:italic;">Sesión activa</span>'
          : `<button onclick="darDeBajaUsuario('${user.username}')" class="btn btn-danger btn-small">Dar de Baja</button>`;

      const rol =
        user.role === 'gerente'
          ? '<span class="status-pill status-terminado">Supervisor</span>'
          : '<span class="status-pill status-en_ejecucion">Inspector</span>';

      tbody.innerHTML += `
        <tr>
          <td style="font-weight:700;">${user.nombreReal}</td>
          <td style="font-size:12px;color:var(--muted);font-family:monospace;">${user.email}</td>
          <td style="font-family:monospace;font-size:12px;color:var(--muted);">${user.username}</td>
          <td>${rol}</td>
          <td style="text-align:right;">${boton}</td>
        </tr>
      `;
    });
  }

  // ==========================================================================
  // GESTIÓN DE INCIDENCIAS / TICKETS
  // ==========================================================================

  function abrirModalTicket() {
    const modal = document.getElementById('modal-ticket');
    if (modal) {
      document.getElementById('form-ticket').reset();
      document.getElementById('ticket-fecha').value = new Date().toISOString().split('T')[0];
      actualizarListaDesplegableTecnicos();
      modal.style.display = 'flex';
    }
  }

  function cerrarModalTicket() {
    const modal = document.getElementById('modal-ticket');
    if (modal) modal.style.display = 'none';
  }

  function crearTicket(e) {
    e.preventDefault();
    const nombre = document.getElementById('ticket-nombre').value.trim();
    const titulo = document.getElementById('ticket-titulo').value.trim();
    const prioridad = document.getElementById('ticket-prioridad').value;
    const tecnicoUsername = document.getElementById('ticket-asignado').value;
    const descripcion = document.getElementById('ticket-descripcion').value.trim();
    const fecha = document.getElementById('ticket-fecha').value;

    if (!tecnicoUsername) {
      alert('Debes asignar un inspector técnico.');
      return;
    }

    const inspector = getUsuarioPorUsername(tecnicoUsername);
    if (!inspector) {
      alert('Inspector no encontrado.');
      return;
    }

    const nuevoTicket = {
      id: Date.now(),
      nombre,
      titulo,
      prioridad,
      descripcion,
      fecha,
      estado: 'pendiente',
      gerenteEmisor: currentUser.nombreReal,
      tecnicoAsignado: inspector.nombreReal,
      tecnicoUsername: tecnicoUsername,
      resena: '',
      fechaCierre: '',
      ultimaModificacion: '',
      imagenes: []
    };

    insertarTicketSQLite(nuevoTicket);
    sincronizarNube();
    renderTickets();
    actualizarSidebarStats();
    cerrarModalTicket();

    // Notificación por correo
    const subject = encodeURIComponent(`[PCP] Nueva Asignación - Prioridad: ${prioridad.toUpperCase()}`);
    const body = encodeURIComponent(
      'MINUTA PCP - CENTRO DE ESPECIALIDADES ANZOÁTEGUI\n' +
      '----------------------------------------\n' +
      `Inspector: ${inspector.nombreReal}\n\n` +
      'DETALLES:\n' +
      `• Suceso: ${titulo}\n` +
      `• Área: ${nombre}\n` +
      `• Prioridad: ${prioridad.toUpperCase()}\n` +
      `• Supervisor: ${currentUser.nombreReal}\n` +
      `• Fecha: ${fecha}\n\n` +
      'DESCRIPCIÓN:\n' +
      `"${descripcion}"\n\n` +
      'Atentamente,\nSala de Control PCP'
    );
    window.location.href = `mailto:${inspector.email}?subject=${subject}&body=${body}`;
  }

  function tomarIncidencia(id) {
    actualizarEstadoTicketSQLite(id, 'en_ejecucion');
    sincronizarNube();
    renderTickets();
    actualizarSidebarStats();
  }

  function finalizarIncidencia(id) {
    const resenaText = document.getElementById('resena-' + id).value.trim();
    if (!resenaText) {
      alert('Por favor redacta el informe final de cierre.');
      return;
    }
    const fileInput = document.getElementById('imagenes-' + id);
    const archivos = fileInput.files;

    function procesar(imagenesProcesadas) {
      finalizarTicketSQLite(id, resenaText, new Date().toISOString().split('T')[0], imagenesProcesadas);
      sincronizarNube();
      renderTickets();
      actualizarSidebarStats();
    }

    if (archivos.length > 0) {
      const imagenes = [];
      let procesadas = 0;
      for (let i = 0; i < archivos.length; i++) {
        const archivo = archivos[i];
        const reader = new FileReader();
        reader.onload = function (e) {
          imagenes.push({ nombre: archivo.name, data: e.target.result });
          procesadas++;
          if (procesadas === archivos.length) procesar(imagenes);
        };
        reader.readAsDataURL(archivo);
      }
    } else {
      procesar([]);
    }
  }

  function puedeModificarTicket(ticket) {
    if (currentUser.role === 'gerente') return true;
    if (currentUser.role === 'tecnico' && ticket.tecnicoUsername === currentUser.username) return true;
    return false;
  }

  function iniciarEdicionTicket(id) {
    editingTicketId = id;
    editImagenesEliminar = [];
    renderTickets();
  }

  function cancelarEdicionTicket() {
    editingTicketId = null;
    editImagenesEliminar = [];
    renderTickets();
  }

  function eliminarImagenEdicion(indice) {
    if (!editImagenesEliminar.includes(indice)) editImagenesEliminar.push(indice);
    const imgWrap = document.getElementById(`edit-img-${editingTicketId}-${indice}`);
    if (imgWrap) imgWrap.style.display = 'none';
  }

  function guardarEdicionTicket(id) {
    const tickets = getTicketsSQLite();
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) return;

    const nuevaResena = document.getElementById('edit-resena-' + id).value.trim();
    if (!nuevaResena) {
      alert('La reseña no puede estar vacía.');
      return;
    }

    const nuevasImagenesInput = document.getElementById('edit-imagenes-' + id);
    const archivosNuevos = nuevasImagenesInput.files;
    const imagenesActuales = ticket.imagenes || [];
    const imagenesFiltradas = imagenesActuales.filter((_, idx) => !editImagenesEliminar.includes(idx));

    function finalizar(imagenesFinales) {
      actualizarEdicionTicketSQLite(id, nuevaResena, imagenesFiltradas, imagenesFinales);
      sincronizarNube();
      editingTicketId = null;
      editImagenesEliminar = [];
      renderTickets();
      alert('¡Incidencia modificada y actualizada en SQLite!');
    }

    if (archivosNuevos.length > 0) {
      const nuevas = [];
      let procesadas = 0;
      for (let i = 0; i < archivosNuevos.length; i++) {
        const archivo = archivosNuevos[i];
        const reader = new FileReader();
        reader.onload = function (e) {
          nuevas.push({ nombre: archivo.name, data: e.target.result });
          procesadas++;
          if (procesadas === archivosNuevos.length) finalizar(nuevas);
        };
        reader.readAsDataURL(archivo);
      }
    } else {
      finalizar([]);
    }
  }

  function renderTickets() {
    const container = document.getElementById('lista-tickets');
    if (!container) return;
    const searchVal = (document.getElementById('search-bar')?.value || '').toLowerCase();
    const sortOrder = document.getElementById('sort-order')?.value || 'date_desc';
    container.innerHTML = '';

    const allTickets = getTicketsSQLite();
    let filtered = allTickets.filter(
      (t) => t.titulo.toLowerCase().includes(searchVal) || t.nombre.toLowerCase().includes(searchVal)
    );

    if (activePriorityFilter !== 'all') {
      filtered = filtered.filter((t) => t.prioridad === activePriorityFilter);
    }
    if (currentUser.role === 'tecnico') {
      filtered = filtered.filter((t) => t.tecnicoUsername === currentUser.username);
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="card-panel" style="grid-column: 1 / -1; text-align: center; padding: 48px 24px;">
          <div style="width: 52px; height: 52px; border-radius: 12px; background: var(--border); display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; color: var(--muted);">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <p style="font-size: 14px; font-weight: 800; color: var(--text); margin-bottom: 4px;">Sin Incidencias Registradas</p>
          <p style="font-size: 12px; color: var(--muted);">No hay reportes que coincidan con la búsqueda o filtro actual.</p>
        </div>
      `;
      return;
    }

    if (sortOrder === 'alpha_asc') {
      filtered.sort((a, b) => a.nombre.localeCompare(b.nombre));
    } else {
      filtered.sort((a, b) => b.id - a.id);
    }

    filtered.forEach((ticket) => {
      const borderColor =
        ticket.prioridad === 'alta'
          ? 'var(--danger)'
          : ticket.prioridad === 'media'
          ? 'var(--warning)'
          : 'var(--success)';
      const prioridadLabel = ticket.prioridad.charAt(0).toUpperCase() + ticket.prioridad.slice(1);
      const estadoLabel = ticket.estado.replace('_', ' ');
      const esEdicion = editingTicketId === ticket.id;
      const puedeEditar = ticket.estado === 'terminado' && puedeModificarTicket(ticket);

      let accionesHtml = '';
      if (currentUser.role === 'tecnico' && ticket.tecnicoUsername === currentUser.username) {
        if (ticket.estado === 'pendiente') {
          accionesHtml = `
            <button onclick="tomarIncidencia(${ticket.id})" class="btn btn-primary" style="width: 100%;">
              Iniciar Inspección
            </button>
          `;
        } else if (ticket.estado === 'en_ejecucion') {
          accionesHtml = `
            <div class="form-compact" style="margin-top: 10px;">
              <textarea id="resena-${ticket.id}" rows="2" placeholder="Informe técnico de cierre..." required></textarea>
              <div>
                <label>Adjuntar Evidencias (Fotos)</label>
                <input type="file" id="imagenes-${ticket.id}" accept="image/*" multiple>
              </div>
              <button onclick="finalizarIncidencia(${ticket.id})" class="btn btn-primary">
                Cerrar Incidencia
              </button>
            </div>
          `;
        }
      }

      let contenidoHtml = '';
      if (esEdicion) {
        let imagenesHtmlEdit = '';
        if (ticket.imagenes && ticket.imagenes.length > 0) {
          imagenesHtmlEdit = `
            <div style="margin-bottom: 8px;">
              <p style="font-size: 11px; font-weight: 700; color: var(--muted); margin-bottom: 6px;">Imágenes actuales (× para eliminar):</p>
              <div class="ticket-imagenes">
          `;
          ticket.imagenes.forEach((img, idx) => {
            const estaEliminada = editImagenesEliminar.includes(idx);
            imagenesHtmlEdit += `
              <div class="img-wrap" id="edit-img-${ticket.id}-${idx}" style="${estaEliminada ? 'display:none;' : ''}">
                <img src="${img.data}" alt="${img.nombre}">
                <button type="button" class="del-img" onclick="eliminarImagenEdicion(${idx})">×</button>
              </div>
            `;
          });
          imagenesHtmlEdit += '</div></div>';
        }

        contenidoHtml = `
          <div class="edit-form">
            <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; color: var(--accent);">Modificando Incidencia</span>
            <div>
              <label>Informe Final</label>
              <textarea id="edit-resena-${ticket.id}" rows="3">${ticket.resena || ''}</textarea>
            </div>
            ${imagenesHtmlEdit}
            <div>
              <label>Agregar más fotos</label>
              <input type="file" id="edit-imagenes-${ticket.id}" accept="image/*" multiple>
            </div>
            <div style="display: flex; gap: 8px;">
              <button onclick="guardarEdicionTicket(${ticket.id})" class="btn btn-primary btn-small" style="flex:1;">Guardar</button>
              <button onclick="cancelarEdicionTicket()" class="btn btn-ghost btn-small" style="flex:1;">Cancelar</button>
            </div>
          </div>
        `;
      } else {
        let resenaHtml = '';
        if (ticket.estado === 'terminado' && ticket.resena) {
          resenaHtml = `
            <div style="margin-top: 10px; padding: 10px; background: var(--border); border-radius: var(--radius-sm); border-left: 3px solid var(--accent);">
              <p style="font-size: 10px; font-weight: 800; text-transform: uppercase; color: var(--muted); margin-bottom: 2px;">Informe Final</p>
              <p style="font-size: 12px; color: var(--text); font-style: italic; line-height: 1.4;">"${ticket.resena}"</p>
            </div>
          `;
        }

        let imagenesHtml = '';
        if (ticket.imagenes && ticket.imagenes.length > 0) {
          imagenesHtml = '<div class="ticket-imagenes">';
          ticket.imagenes.forEach((img) => {
            imagenesHtml += `<img src="${img.data}" alt="${img.nombre}" title="${img.nombre}" onclick="verImagen('${img.data}')">`;
          });
          imagenesHtml += '</div>';
        }

        let btnModificar = '';
        if (puedeEditar) {
          btnModificar = `<button onclick="iniciarEdicionTicket(${ticket.id})" class="btn btn-ghost btn-small" style="width:100%; margin-top: 10px;">Modificar Reporte</button>`;
        }

        contenidoHtml = resenaHtml + imagenesHtml + btnModificar;
      }

      container.innerHTML += `
        <div class="ticket-card" style="border-top: 3px solid ${borderColor};">
          <div class="ticket-header">
            <div style="flex: 1; min-width: 0;">
              <span class="status-pill status-${ticket.estado}">${estadoLabel}</span>
              <h4 class="ticket-title">${ticket.titulo}</h4>
              <p class="ticket-meta">
                <span class="priority-dot" style="background: ${borderColor};"></span>
                ${prioridadLabel} · ${ticket.nombre}
              </p>
            </div>
            <span class="ticket-id">#${ticket.id.toString().slice(-6)}</span>
          </div>

          <div class="ticket-desc-box">
            <p class="ticket-desc-text">${ticket.descripcion}</p>
          </div>

          <div class="ticket-info-grid">
            <p style="color: var(--muted);"><strong>Inspector:</strong></p>
            <p style="text-align: right; font-weight: 600;">${ticket.tecnicoAsignado}</p>
            <p style="color: var(--muted);"><strong>Fecha:</strong></p>
            <p style="text-align: right; font-weight: 600;">${ticket.fecha}</p>
          </div>

          ${contenidoHtml}
          ${accionesHtml && !esEdicion ? `<div style="margin-top: 10px;">${accionesHtml}</div>` : ''}
        </div>
      `;
    });
  }

  // ==========================================================================
  // DASHBOARD ANALÍTICO (Métricas en 1 línea + Gráficos en otra línea)
  // ==========================================================================

  function filterFromDashboard(prioridad) {
    activePriorityFilter = prioridad;
    const filterAlert = document.getElementById('filter-alert');
    const priorityNameEl = document.getElementById('filter-priority-name');
    if (prioridad === 'all') {
      if (filterAlert) filterAlert.style.display = 'none';
    } else {
      if (priorityNameEl) priorityNameEl.innerText = prioridad;
      if (filterAlert) filterAlert.style.display = 'flex';
    }
    switchTab('tickets');
  }

  function clearFilter() {
    activePriorityFilter = 'all';
    const filterAlert = document.getElementById('filter-alert');
    if (filterAlert) filterAlert.style.display = 'none';
    renderTickets();
  }

  function initDashboards() {
    const allTickets = getTicketsSQLite();
    const openTickets = allTickets.filter((t) => t.estado === 'pendiente' || t.estado === 'en_ejecucion');

    // Actualizar Casillas Métricas (Fila 1)
    const counterTotal = document.getElementById('counter-total');
    const counterAlta = document.getElementById('counter-alta');
    const counterMedia = document.getElementById('counter-media');
    const counterBaja = document.getElementById('counter-baja');

    if (counterTotal) counterTotal.innerText = openTickets.length;
    if (counterAlta) counterAlta.innerText = openTickets.filter((t) => t.prioridad === 'alta').length;
    if (counterMedia) counterMedia.innerText = openTickets.filter((t) => t.prioridad === 'media').length;
    if (counterBaja) counterBaja.innerText = openTickets.filter((t) => t.prioridad === 'baja').length;

    // Destruir instancias previas de gráficos
    ['dia', 'mes', 'prioridad'].forEach((type) => {
      if (chartInstances[type]) chartInstances[type].destroy();
    });

    // Fila 2: Preparación de datos para gráficos
    const diasLabels = [];
    const diasData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const isoStr = d.toISOString().split('T')[0];
      diasLabels.push(d.toLocaleDateString('es-ES', { weekday: 'short' }));
      diasData.push(allTickets.filter((t) => t.fecha === isoStr).length);
    }

    const mesesLabels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const mesesData = Array(12).fill(0);
    allTickets.forEach((t) => {
      const mes = new Date(t.fecha + 'T00:00:00').getMonth();
      if (!isNaN(mes)) mesesData[mes]++;
    });

    const totalAlta = allTickets.filter((t) => t.prioridad === 'alta').length;
    const totalMedia = allTickets.filter((t) => t.prioridad === 'media').length;
    const totalBaja = allTickets.filter((t) => t.prioridad === 'baja').length;

    const textColor = currentTheme === 'dark' ? '#94a3b8' : '#64748b';
    const gridColor = currentTheme === 'dark' ? 'rgba(148, 163, 184, 0.1)' : 'rgba(15, 23, 42, 0.06)';

    const chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false, labels: { color: textColor } } },
      scales: {
        y: { beginAtZero: true, ticks: { color: textColor, stepSize: 1 }, grid: { color: gridColor } },
        x: { ticks: { color: textColor }, grid: { display: false } }
      }
    };

    const canvasDia = document.getElementById('chart-dia');
    if (canvasDia) {
      chartInstances['dia'] = new Chart(canvasDia, {
        type: 'line',
        data: {
          labels: diasLabels,
          datasets: [{
            label: 'Novedades',
            data: diasData,
            borderColor: '#0d9669',
            backgroundColor: 'rgba(13, 150, 105, 0.15)',
            tension: 0.35,
            fill: true,
            pointBackgroundColor: '#0d9669',
            pointRadius: 4,
            pointHoverRadius: 6
          }]
        },
        options: chartDefaults
      });
    }

    const canvasMes = document.getElementById('chart-mes');
    if (canvasMes) {
      chartInstances['mes'] = new Chart(canvasMes, {
        type: 'bar',
        data: {
          labels: mesesLabels,
          datasets: [{
            label: 'Novedades',
            data: mesesData,
            backgroundColor: '#0d9669',
            borderRadius: 6,
            hoverBackgroundColor: '#0b855c'
          }]
        },
        options: chartDefaults
      });
    }

    const canvasPrioridad = document.getElementById('chart-prioridad');
    if (canvasPrioridad) {
      chartInstances['prioridad'] = new Chart(canvasPrioridad, {
        type: 'doughnut',
        data: {
          labels: ['Alta', 'Media', 'Baja'],
          datasets: [{
            data: [totalAlta, totalMedia, totalBaja],
            backgroundColor: ['#dc2626', '#d97706', '#059669'],
            borderWidth: 0,
            hoverOffset: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: textColor, font: { size: 11, weight: '600' }, padding: 14 }
            }
          },
          cutout: '65%'
        }
      });
    }
  }

  function actualizarSidebarStats() {
    const allTickets = getTicketsSQLite();
    const pend = allTickets.filter((t) => t.estado === 'pendiente').length;
    const ejec = allTickets.filter((t) => t.estado === 'en_ejecucion').length;
    const cerr = allTickets.filter((t) => t.estado === 'terminado').length;

    const elPend = document.getElementById('stat-pendientes');
    const elEjec = document.getElementById('stat-ejecucion');
    const elCerr = document.getElementById('stat-cerrados');

    if (elPend) elPend.textContent = `${pend} Pendientes`;
    if (elEjec) elEjec.textContent = `${ejec} En ejecución`;
    if (elCerr) elCerr.textContent = `${cerr} Cerrados`;
  }

  // ==========================================================================
  // EXPORTACIÓN PDF Y JSON
  // ==========================================================================

  function generarReportePDF() {
    try {
      const jsPDF = window.jspdf.jsPDF;
      const doc = new jsPDF('l', 'pt', 'a4');
      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(18);
      doc.text('CENTRO DE ESPECIALIDADES ANZOÁTEGUI', 40, 45);
      doc.setFontSize(10);
      doc.setFont('Helvetica', 'normal');
      doc.setTextColor(100);
      doc.text('Auditoría PCP - RIF: J-08023405-4', 40, 62);
      doc.text(`Supervisor: ${currentUser.nombreReal} | Fecha: ${new Date().toLocaleString()}`, 40, 75);

      const tableRows = [];
      const allTickets = getTicketsSQLite();
      allTickets.forEach((t, i) => {
        tableRows.push([
          i + 1,
          t.fecha,
          t.nombre,
          t.prioridad.toUpperCase(),
          t.titulo,
          t.gerenteEmisor,
          t.tecnicoAsignado,
          t.estado.toUpperCase().replace('_', ' '),
          t.resena || 'N/A'
        ]);
      });

      doc.autoTable({
        head: [['N°', 'Fecha', 'Área', 'Prioridad', 'Novedad', 'Supervisor', 'Inspector', 'Estado', 'Informe']],
        body: tableRows,
        startY: 95,
        theme: 'striped',
        headStyles: { fillColor: [13, 150, 105], fontStyle: 'bold', fontSize: 9, textColor: 255 },
        styles: { fontSize: 8, overflow: 'linebreak' },
        columnStyles: { 4: { cellWidth: 120 }, 8: { cellWidth: 150 } }
      });

      doc.save('auditoria_pcp.pdf');
    } catch (err) {
      alert('Error al generar PDF: ' + err.message);
    }
  }

  function exportarDatosJSON() {
    const datos = {
      usersDatabase: getUsuariosSQLite(),
      tickets: getTicketsSQLite(),
      exportadoEn: new Date().toISOString(),
      sistema: 'PCP-CEA-SQLite'
    };
    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pcp-datos-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importarDatosJSON(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!confirm('¿Reemplazar todos los datos actuales con este archivo JSON?')) {
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const datos = JSON.parse(e.target.result);
        if (datos.usersDatabase && db) {
          db.run('DELETE FROM users');
          Object.values(datos.usersDatabase).forEach((u) => {
            guardarUsuarioSQLite(u.username, u.password, u.role, u.nombreReal, u.email);
          });
        }
        if (datos.tickets && db) {
          db.run('DELETE FROM tickets');
          db.run('DELETE FROM ticket_images');
          datos.tickets.forEach((t) => insertarTicketSQLite(t));
        }
        guardarBD();
        sincronizarNube();
        actualizarListaDesplegableTecnicos();
        renderTickets();
        renderUsuariosTable();
        actualizarSidebarStats();
        alert('¡Datos JSON importados y guardados en SQLite!');
      } catch (err) {
        alert('Error: archivo inválido. ' + err.message);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  // ==========================================================================
  // SINCRONIZACIÓN EN NUBE (JSONBin.io)
  // ==========================================================================

  function sincronizarNube() {
    if (!JSONBIN_CONFIG || isSyncing) return Promise.resolve();
    isSyncing = true;
    const datos = {
      usersDatabase: getUsuariosSQLite(),
      tickets: getTicketsSQLite()
    };
    return fetch(`${JSONBIN_API}/b/${JSONBIN_CONFIG.binId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_CONFIG.masterKey
      },
      body: JSON.stringify(datos)
    })
      .then((r) => r.json())
      .catch((err) => console.error('Error sincronizando nube:', err))
      .finally(() => { isSyncing = false; });
  }

  function mostrarSyncIndicator(texto) {
    const indicador = document.getElementById('sync-indicator');
    const textoEl = document.getElementById('sync-text');
    if (!indicador) return;
    if (texto) {
      if (textoEl) textoEl.textContent = texto;
      indicador.style.display = 'inline-flex';
    } else {
      indicador.style.display = 'none';
    }
  }

  function sincronizacionAutomatica() {
    if (!JSONBIN_CONFIG || !currentUser) return;
    mostrarSyncIndicator('Sincronizando');
    fetch(`${JSONBIN_API}/b/${JSONBIN_CONFIG.binId}/latest`, {
      method: 'GET',
      headers: { 'X-Master-Key': JSONBIN_CONFIG.masterKey, 'X-Bin-Meta': 'false' }
    })
      .then((r) => r.json())
      .then((data) => {
        mostrarSyncIndicator(null);
        if (data.message) return;
        if (data.usersDatabase && db) {
          db.run('DELETE FROM users');
          Object.values(data.usersDatabase).forEach((u) => {
            guardarUsuarioSQLite(u.username, u.password, u.role, u.nombreReal, u.email);
          });
        }
        if (data.tickets && db) {
          db.run('DELETE FROM tickets');
          db.run('DELETE FROM ticket_images');
          data.tickets.forEach((t) => insertarTicketSQLite(t));
        }
        guardarBD();
        if (currentTab === 'tickets') renderTickets();
        else if (currentTab === 'usuarios') renderUsuariosTable();
        else if (currentTab === 'dashboard') initDashboards();
        actualizarListaDesplegableTecnicos();
        actualizarSidebarStats();
      })
      .catch((err) => {
        console.error('Sync error:', err);
        mostrarSyncIndicator(null);
      });
  }

  function iniciarSincronizacionAutomatica() {
    detenerSincronizacionAutomatica();
    if (JSONBIN_CONFIG) syncInterval = setInterval(sincronizacionAutomatica, 30000);
  }

  function detenerSincronizacionAutomatica() {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  }

  function actualizarIndicadorNube() {
    const indicator = document.getElementById('cloud-status-nav');
    const statusText = document.getElementById('cloud-status-text');
    const detalle = document.getElementById('nube-estado-detalle');
    const btnSubir = document.getElementById('btn-subir');
    const btnBajar = document.getElementById('btn-bajar');
    if (JSONBIN_CONFIG && JSONBIN_CONFIG.binId) {
      if (indicator) {
        indicator.classList.remove('cloud-disconnected');
        indicator.classList.add('cloud-connected');
      }
      if (statusText) statusText.textContent = 'Nube';
      if (detalle) detalle.textContent = `Conectado · Bin: ${JSONBIN_CONFIG.binId.substring(0, 8)}...`;
      if (btnSubir) btnSubir.disabled = false;
      if (btnBajar) btnBajar.disabled = false;
    } else {
      if (indicator) {
        indicator.classList.remove('cloud-connected');
        indicator.classList.add('cloud-disconnected');
      }
      if (statusText) statusText.textContent = 'Local';
      if (detalle) detalle.textContent = 'Sin conexión remota · Datos locales en SQLite';
      if (btnSubir) btnSubir.disabled = true;
      if (btnBajar) btnBajar.disabled = true;
    }
  }

  function configurarJSONBin() {
    const masterKey = document.getElementById('jsonbin-master-key').value.trim();
    const binId = document.getElementById('jsonbin-bin-id').value.trim();
    if (!masterKey) {
      alert('Ingresa tu X-Master-Key');
      return;
    }

    if (binId) {
      JSONBIN_CONFIG = { masterKey, binId };
      localStorage.setItem('jsonbin_config', JSON.stringify(JSONBIN_CONFIG));
      actualizarIndicadorNube();
      iniciarSincronizacionAutomatica();
      alert('¡Configuración de Nube guardada!');
    } else {
      const datosIniciales = {
        usersDatabase: getUsuariosSQLite(),
        tickets: getTicketsSQLite()
      };
      fetch(`${JSONBIN_API}/b`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': masterKey,
          'X-Bin-Name': 'PCP-Centro-Especialidades'
        },
        body: JSON.stringify(datosIniciales)
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.metadata && data.metadata.id) {
            JSONBIN_CONFIG = { masterKey, binId: data.metadata.id };
            localStorage.setItem('jsonbin_config', JSON.stringify(JSONBIN_CONFIG));
            actualizarIndicadorNube();
            iniciarSincronizacionAutomatica();
            alert(`¡Bin creado en JSONBin! ID: ${data.metadata.id}`);
          }
        })
        .catch((err) => alert('Error al conectar nube: ' + err.message));
    }
  }

  function desconectarJSONBin() {
    JSONBIN_CONFIG = null;
    localStorage.removeItem('jsonbin_config');
    detenerSincronizacionAutomatica();
    mostrarSyncIndicator(null);
    document.getElementById('jsonbin-master-key').value = '';
    document.getElementById('jsonbin-bin-id').value = '';
    actualizarIndicadorNube();
    alert('Desconectado de la nube. Los datos siguen seguros en tu base de datos local SQLite.');
  }

  // ==========================================================================
  // MODAL DE VISUALIZACIÓN DE IMÁGENES
  // ==========================================================================

  function verImagen(src) {
    const modal = document.getElementById('modal-imagen');
    const imgEl = document.getElementById('modal-imagen-src');
    if (modal && imgEl) {
      imgEl.src = src;
      modal.style.display = 'flex';
    }
  }

  function cerrarModalImagen() {
    const modal = document.getElementById('modal-imagen');
    if (modal) modal.style.display = 'none';
  }

  // ==========================================================================
  // EXPOSICIÓN GLOBAL DE FUNCIONES EN WINDOW
  // ==========================================================================
  window.toggleTheme = toggleTheme;
  window.checkSystemSetup = checkSystemSetup;
  window.handleInitialSetup = handleInitialSetup;
  window.handleLogin = handleLogin;
  window.logout = logout;
  window.handlePasswordChange = handlePasswordChange;
  window.switchTab = switchTab;
  window.abrirModalTicket = abrirModalTicket;
  window.cerrarModalTicket = cerrarModalTicket;
  window.crearTicket = crearTicket;
  window.tomarIncidencia = tomarIncidencia;
  window.finalizarIncidencia = finalizarIncidencia;
  window.iniciarEdicionTicket = iniciarEdicionTicket;
  window.cancelarEdicionTicket = cancelarEdicionTicket;
  window.guardarEdicionTicket = guardarEdicionTicket;
  window.eliminarImagenEdicion = eliminarImagenEdicion;
  window.renderTickets = renderTickets;
  window.registrarUsuario = registrarUsuario;
  window.darDeBajaUsuario = darDeBajaUsuario;
  window.renderUsuariosTable = renderUsuariosTable;
  window.filterFromDashboard = filterFromDashboard;
  window.clearFilter = clearFilter;
  window.initDashboards = initDashboards;
  window.generarReportePDF = generarReportePDF;
  window.exportarDatosJSON = exportarDatosJSON;
  window.importarDatosJSON = importarDatosJSON;
  window.exportarBaseDatosSQLite = exportarBaseDatosSQLite;
  window.importarBaseDatosSQLite = importarBaseDatosSQLite;
  window.borrarBaseDatosCompleta = borrarBaseDatosCompleta;
  window.configurarJSONBin = configurarJSONBin;
  window.desconectarJSONBin = desconectarJSONBin;
  window.verImagen = verImagen;
  window.cerrarModalImagen = cerrarModalImagen;

  // ==========================================================================
  // INICIALIZACIÓN AL CARGAR LA PÁGINA
  // ==========================================================================
  document.addEventListener('DOMContentLoaded', async () => {
    applyTheme();
    await inicializarSQLite();
    checkSystemSetup();
    actualizarIndicadorNube();
  });

})();

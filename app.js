'use strict';

// ============================================
// CONFIGURATION
// ============================================
const APP_VERSION = '6.0.0';
const SYNC_INTERVAL = 30000; // 30 seconds
const MAX_RETRY_ATTEMPTS = 3;
const BATCH_SIZE = 25;

// ============================================
// SUPABASE CLIENT
// ============================================
let supabase = null;
let currentUser = null;
let syncTimer = null;
let abortController = null;

if (window.supabaseClient) {
  supabase = window.supabaseClient.supabase;
}

// ============================================
// DATABASE & STATE MANAGEMENT
// ============================================
let DB = { 
  classrooms: [], 
  nextId: 1, 
  user: null,
  lastSync: null,
  syncStatus: 'idle', // 'idle', 'syncing', 'error', 'offline'
  pendingChanges: [],
  exportSettings: {
    color: { h: 30, s: 60, l: 50, a: 100 },
    logo: null,
    logoName: null,
    logoSize: null
  }
};

// Index for fast lookups
let DB_INDEX = {
  classroomsById: new Map(),
  studentsByClassroom: new Map(),
  lessonsByClassroom: new Map(),
  columnsByClassroom: new Map()
};

// API base
const API_BASE = window.location.origin;

// ============================================
// INDEX MANAGEMENT
// ============================================
function rebuildIndex() {
  DB_INDEX = {
    classroomsById: new Map(),
    studentsByClassroom: new Map(),
    lessonsByClassroom: new Map(),
    columnsByClassroom: new Map()
  };
  
  DB.classrooms.forEach(c => {
    DB_INDEX.classroomsById.set(c.id, c);
    DB_INDEX.studentsByClassroom.set(c.id, new Map(c.students.map(s => [s.id, s])));
    DB_INDEX.lessonsByClassroom.set(c.id, new Map(c.lessons.map(l => [l.id, l])));
    DB_INDEX.columnsByClassroom.set(c.id, new Map(c.columns.map(col => [col.id, col])));
  });
}

function getC(id) { return DB_INDEX.classroomsById.get(id); }
function getStudent(classId, studentId) { 
  return DB_INDEX.studentsByClassroom.get(classId)?.get(studentId);
}
function getLesson(classId, lessonId) {
  return DB_INDEX.lessonsByClassroom.get(classId)?.get(lessonId);
}
function getColumn(classId, columnId) {
  return DB_INDEX.columnsByClassroom.get(classId)?.get(columnId);
}

let CID = null, LID = null;
function CC() { return getC(CID); }
function CL() { return CID && LID ? getLesson(CID, LID) : null; }

// ============================================
// DATA MERGING & SYNC
// ============================================
function mergeData(local, remote, strategy = 'timestamp') {
  if (!remote) return local;
  
  const merged = {
    ...local,
    classrooms: [],
    nextId: Math.max(local.nextId || 1, remote.nextId || 1),
    lastSync: new Date().toISOString()
  };
  
  // Create maps for efficient merging
  const localClassrooms = new Map(local.classrooms?.map(c => [c.id, c]) || []);
  const remoteClassrooms = new Map(remote.classrooms?.map(c => [c.id, c]) || []);
  
  // Merge all classroom IDs
  const allIds = new Set([...localClassrooms.keys(), ...remoteClassrooms.keys()]);
  
  for (const id of allIds) {
    const localC = localClassrooms.get(id);
    const remoteC = remoteClassrooms.get(id);
    
    if (localC && !remoteC) {
      // Only in local - keep it
      merged.classrooms.push(localC);
    } else if (!localC && remoteC) {
      // Only in remote - add it
      merged.classrooms.push(remoteC);
    } else if (localC && remoteC) {
      // In both - merge based on timestamp
      const localTime = new Date(localC.updatedAt || 0).getTime();
      const remoteTime = new Date(remoteC.updatedAt || 0).getTime();
      
      if (remoteTime > localTime) {
        // Remote is newer - use it but preserve local changes if any
        merged.classrooms.push({
          ...remoteC,
          students: mergeStudents(localC.students || [], remoteC.students || []),
          lessons: mergeLessons(localC.lessons || [], remoteC.lessons || [])
        });
      } else {
        // Local is newer or equal - keep it
        merged.classrooms.push(localC);
      }
    }
  }
  
  return merged;
}

function mergeStudents(local, remote) {
  const localMap = new Map(local.map(s => [s.id, s]));
  const remoteMap = new Map(remote.map(s => [s.id, s]));
  const merged = [];
  
  for (const [id, localS] of localMap) {
    const remoteS = remoteMap.get(id);
    if (remoteS) {
      const localTime = new Date(localS.updatedAt || 0).getTime();
      const remoteTime = new Date(remoteS.updatedAt || 0).getTime();
      merged.push(remoteTime > localTime ? remoteS : localS);
    } else {
      merged.push(localS);
    }
  }
  
  for (const [id, remoteS] of remoteMap) {
    if (!localMap.has(id)) {
      merged.push(remoteS);
    }
  }
  
  return merged;
}

function mergeLessons(local, remote) {
  // Similar to mergeStudents
  const localMap = new Map(local.map(l => [l.id, l]));
  const remoteMap = new Map(remote.map(l => [l.id, l]));
  const merged = [];
  
  for (const [id, localL] of localMap) {
    const remoteL = remoteMap.get(id);
    if (remoteL) {
      const localTime = new Date(localL.updatedAt || 0).getTime();
      const remoteTime = new Date(remoteL.updatedAt || 0).getTime();
      
      if (remoteTime > localTime) {
        merged.push(remoteL);
      } else {
        merged.push(localL);
      }
    } else {
      merged.push(localL);
    }
  }
  
  for (const [id, remoteL] of remoteMap) {
    if (!localMap.has(id)) {
      merged.push(remoteL);
    }
  }
  
  return merged;
}

// ============================================
// LOAD/SAVE FUNCTIONS
// ============================================
async function loadDB() {
  try {
    abortController = new AbortController();
    
    // Load from localStorage with backup
    const localData = loadFromLocalStorage();
    if (localData) {
      DB = localData;
    }
    
    // Ensure exportSettings exists
    if (!DB.exportSettings) {
      DB.exportSettings = { color: { h: 30, s: 60, l: 50, a: 100 } };
    }
    
    // Add timestamps for merge
    DB.classrooms.forEach(c => {
      if (!c.updatedAt) c.updatedAt = new Date().toISOString();
      c.students?.forEach(s => { if (!s.updatedAt) s.updatedAt = c.updatedAt; });
      c.lessons?.forEach(l => { if (!l.updatedAt) l.updatedAt = c.updatedAt; });
    });
    
    // Rebuild index
    rebuildIndex();
    
    // If user is logged in with Supabase, sync with cloud
    if (supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
      await syncWithCloud();
    }
    
    // Start auto-sync if logged in
    if (DB.user?.mode === 'supabase') {
      startAutoSync();
    }
    
    // Add studentIds to old lessons
    migrateLegacyData();
    
  } catch (e) {
    console.error('Failed to load DB', e);
    showToast('⚠️ Failed to load data. Using backup if available.');
    await loadFromBackup();
  }
}

function loadFromLocalStorage() {
  try {
    const main = localStorage.getItem('gj_v6_pro');
    const backup = localStorage.getItem('gj_v6_pro_backup');
    
    if (main) {
      return JSON.parse(main);
    } else if (backup) {
      return JSON.parse(backup);
    }
  } catch (e) {
    console.error('Error loading from localStorage:', e);
  }
  return null;
}

async function loadFromBackup() {
  try {
    const backup = localStorage.getItem('gj_v6_pro_backup');
    if (backup) {
      DB = JSON.parse(backup);
      rebuildIndex();
      showToast('✅ Restored from backup');
    }
  } catch (e) {
    console.error('Failed to load backup:', e);
  }
}

function migrateLegacyData() {
  DB.classrooms.forEach(classroom => {
    classroom.lessons.forEach(lesson => {
      if (!lesson.studentIds) {
        lesson.studentIds = classroom.students.map(s => s.id);
      }
      if (!lesson.updatedAt) {
        lesson.updatedAt = new Date().toISOString();
      }
    });
    classroom.students.forEach(s => {
      if (!s.updatedAt) s.updatedAt = new Date().toISOString();
    });
  });
}

// ============================================
// CLOUD SYNC
// ============================================
async function syncWithCloud() {
  if (!supabase || !DB.user?.id || DB.user?.mode !== 'supabase') {
    return;
  }
  
  if (DB.syncStatus === 'syncing') {
    console.log('Sync already in progress');
    return;
  }
  
  DB.syncStatus = 'syncing';
  updateSyncUI();
  
  try {
    // Load cloud data
    const cloudData = await loadUserDataFromSupabase(DB.user.id);
    
    // Merge with local data
    const merged = mergeData(DB, cloudData, 'timestamp');
    
    // Check for conflicts
    const conflicts = detectConflicts(DB, cloudData);
    if (conflicts.length > 0) {
      await resolveConflicts(conflicts);
    }
    
    // Apply merged data
    DB = merged;
    rebuildIndex();
    
    // Save to cloud
    await saveUserDataToSupabase(DB.user.id);
    
    // Save to local
    saveToLocalStorage();
    
    DB.lastSync = new Date().toISOString();
    DB.syncStatus = 'idle';
    DB.pendingChanges = [];
    
    updateSyncUI();
    showToast('✅ Synced with cloud');
    
  } catch (error) {
    console.error('Sync failed:', error);
    DB.syncStatus = 'error';
    updateSyncUI();
    showToast('❌ Sync failed. Changes saved locally.');
    
    // Queue changes for later sync
    queuePendingChanges();
  }
}

function detectConflicts(local, cloud) {
  const conflicts = [];
  
  // Simple conflict detection - can be enhanced
  local.classrooms?.forEach(localC => {
    const cloudC = cloud.classrooms?.find(c => c.id === localC.id);
    if (cloudC && localC.updatedAt !== cloudC.updatedAt) {
      conflicts.push({
        type: 'classroom',
        id: localC.id,
        local: localC,
        cloud: cloudC
      });
    }
  });
  
  return conflicts;
}

async function resolveConflicts(conflicts) {
  for (const conflict of conflicts) {
    // Show conflict resolution UI
    const resolution = await showConflictDialog(conflict);
    if (resolution === 'local') {
      // Keep local, will overwrite cloud
    } else if (resolution === 'cloud') {
      // Use cloud version
      const index = DB.classrooms.findIndex(c => c.id === conflict.id);
      if (index >= 0) {
        DB.classrooms[index] = conflict.cloud;
      }
    } else if (resolution === 'merge') {
      // Manual merge - show diff editor
      await showMergeEditor(conflict);
    }
  }
}

function queuePendingChanges() {
  DB.pendingChanges = [{
    timestamp: new Date().toISOString(),
    changes: ['Data modified while offline']
  }];
  saveToLocalStorage();
}

function saveToLocalStorage() {
  try {
    // Save main
    localStorage.setItem('gj_v6_pro', JSON.stringify(DB));
    // Save backup
    localStorage.setItem('gj_v6_pro_backup', JSON.stringify(DB));
  } catch (e) {
    console.error('Failed to save to localStorage:', e);
  }
}

function updateSyncUI() {
  const syncIndicator = document.getElementById('sync-indicator');
  if (!syncIndicator) return;
  
  syncIndicator.className = `sync-indicator ${DB.syncStatus}`;
  syncIndicator.textContent = DB.syncStatus === 'syncing' ? '⟳ Syncing...' :
                             DB.syncStatus === 'error' ? '⚠️ Offline' :
                             DB.lastSync ? `✓ Synced ${timeAgo(DB.lastSync)}` : '';
}

function timeAgo(timestamp) {
  const seconds = Math.floor((new Date() - new Date(timestamp)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (navigator.onLine && DB.user?.mode === 'supabase') {
      syncWithCloud();
    }
  }, SYNC_INTERVAL);
}

function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// ============================================
// SUPABASE DATA LOADING (BATCHED)
// ============================================
async function loadUserDataFromSupabase(userId) {
  try {
    // Batch load all data
    const [classrooms, settings] = await Promise.all([
      supabase.from('classrooms').select('*').eq('user_id', userId),
      supabase.from('export_settings').select('*').eq('user_id', userId).maybeSingle()
    ]);
    
    if (classrooms.error) throw classrooms.error;
    if (!classrooms.data || classrooms.data.length === 0) {
      return { classrooms: [] };
    }
    
    // Get all classroom IDs
    const classroomIds = classrooms.data.map(c => c.id);
    
    // Batch load all related data
    const [students, lessons, columns] = await Promise.all([
      supabase.from('students').select('*').in('classroom_id', classroomIds),
      supabase.from('lessons').select('*').in('classroom_id', classroomIds),
      supabase.from('columns').select('*').in('classroom_id', classroomIds)
    ]);
    
    if (students.error) throw students.error;
    if (lessons.error) throw lessons.error;
    if (columns.error) throw columns.error;
    
    // Create maps for efficient lookup
    const studentsByClassroom = new Map();
    students.data?.forEach(s => {
      if (!studentsByClassroom.has(s.classroom_id)) {
        studentsByClassroom.set(s.classroom_id, []);
      }
      studentsByClassroom.get(s.classroom_id).push(s);
    });
    
    const lessonsByClassroom = new Map();
    lessons.data?.forEach(l => {
      if (!lessonsByClassroom.has(l.classroom_id)) {
        lessonsByClassroom.set(l.classroom_id, []);
      }
      lessonsByClassroom.get(l.classroom_id).push(l);
    });
    
    const columnsByClassroom = new Map();
    columns.data?.forEach(col => {
      if (!columnsByClassroom.has(col.classroom_id)) {
        columnsByClassroom.set(col.classroom_id, []);
      }
      columnsByClassroom.get(col.classroom_id).push(col);
    });
    
    // Get all lesson IDs
    const lessonIds = lessons.data?.map(l => l.id) || [];
    
    // Batch load grades and attendance for all lessons
    let grades = [];
    let attendance = [];
    
    if (lessonIds.length > 0) {
      // Process in batches to avoid URL length limits
      for (let i = 0; i < lessonIds.length; i += BATCH_SIZE) {
        const batch = lessonIds.slice(i, i + BATCH_SIZE);
        const [gradesBatch, attendanceBatch] = await Promise.all([
          supabase.from('grades').select('*').in('lesson_id', batch),
          supabase.from('attendance').select('*').in('lesson_id', batch)
        ]);
        
        if (gradesBatch.error) throw gradesBatch.error;
        if (attendanceBatch.error) throw attendanceBatch.error;
        
        grades = grades.concat(gradesBatch.data || []);
        attendance = attendance.concat(attendanceBatch.data || []);
      }
    }
    
    // Create maps for grades and attendance
    const gradesByLesson = new Map();
    grades.forEach(g => {
      if (!gradesByLesson.has(g.lesson_id)) {
        gradesByLesson.set(g.lesson_id, []);
      }
      gradesByLesson.get(g.lesson_id).push(g);
    });
    
    const attendanceByLesson = new Map();
    attendance.forEach(a => {
      if (!attendanceByLesson.has(a.lesson_id)) {
        attendanceByLesson.set(a.lesson_id, []);
      }
      attendanceByLesson.get(a.lesson_id).push(a);
    });
    
    // Build classroom objects
    const cloudClassrooms = classrooms.data.map(c => {
      const classroomStudents = studentsByClassroom.get(c.id) || [];
      const classroomLessons = lessonsByClassroom.get(c.id) || [];
      const classroomColumns = columnsByClassroom.get(c.id) || [];
      
      // Build lessons with data
      const lessonsWithData = classroomLessons.map(l => {
        const lessonGrades = gradesByLesson.get(l.id) || [];
        const lessonAttendance = attendanceByLesson.get(l.id) || [];
        
        const data = {};
        
        lessonGrades.forEach(g => {
          if (g.column_id) {
            data[`col_${g.column_id}_${g.student_id}`] = g.grade;
          }
        });
        
        lessonAttendance.forEach(a => {
          data[`att_${a.student_id}`] = a.status;
        });
        
        return {
          id: l.lesson_number,
          topic: l.title,
          date: l.lesson_date,
          num: l.lesson_number,
          mode: l.mode,
          studentIds: l.student_ids || [],
          data,
          updatedAt: l.updated_at
        };
      });
      
      return {
        id: c.id, // Keep UUID as string, don't parse to int
        name: c.name,
        subject: c.subject || '',
        teacher: c.teacher_name || '',
        students: classroomStudents.map(s => ({
          id: s.student_number,
          name: s.name,
          phone: s.phone || '',
          email: s.email || '',
          parentName: s.parent_name || '',
          parentPhone: s.parent_phone || '',
          note: s.notes || '',
          updatedAt: s.updated_at
        })),
        lessons: lessonsWithData,
        columns: classroomColumns.map(col => ({
          id: col.column_number,
          name: col.name,
          ielts: col.ielts || false,
          lessonId: col.lesson_id ? classroomLessons.find(l => l.id === col.lesson_id)?.lesson_number : null
        })),
        nextSid: c.next_student_id,
        nextLid: c.next_lesson_id,
        nextCid: c.next_column_id,
        updatedAt: c.updated_at
      };
    });
    
    // Load export settings
    let exportSettings = DB.exportSettings;
    if (settings.data) {
      exportSettings = {
        color: settings.data.color || { h: 30, s: 60, l: 50, a: 100 },
        logo: settings.data.logo_data || null,
        logoName: settings.data.logo_name || null,
        logoSize: settings.data.logo_size || null
      };
    }
    
    return {
      classrooms: cloudClassrooms,
      exportSettings,
      nextId: Math.max(...cloudClassrooms.map(c => parseInt(c.id.split('-')[0]) || 0), 0) + 1
    };
    
  } catch (e) {
    console.error('Error loading from Supabase:', e);
    throw e;
  }
}

// ============================================
// SUPABASE DATA SAVING (WITH TRANSACTIONS)
// ============================================
async function saveUserDataToSupabase(userId) {
  if (!supabase) throw new Error('Supabase not initialized');
  
  const errors = [];
  const operations = [];
  
  try {
    // Start by clearing existing data (in a transaction if possible)
    operations.push(
      () => supabase.from('classrooms').delete().eq('user_id', userId)
    );
    
    // Save each classroom
    for (const c of DB.classrooms) {
      // Insert classroom
      operations.push(async () => {
        const { data, error } = await supabase
          .from('classrooms')
          .insert({
            user_id: userId,
            name: c.name,
            subject: c.subject,
            teacher_name: c.teacher,
            next_student_id: c.nextSid,
            next_lesson_id: c.nextLid,
            next_column_id: c.nextCid
          })
          .select()
          .single();
          
        if (error) throw error;
        return { type: 'classroom', data, originalId: c.id };
      });
    }
    
    // Execute all operations and collect results
    const results = [];
    for (const op of operations) {
      try {
        const result = await op();
        results.push(result);
      } catch (error) {
        errors.push(error);
        console.error('Operation failed:', error);
      }
    }
    
    // Get mapping between original IDs and new UUIDs
    const classroomMap = new Map();
    results
      .filter(r => r?.type === 'classroom')
      .forEach(r => classroomMap.set(r.originalId, r.data.id));
    
    // Save students, lessons, etc. in batches
    await saveClassroomsData(userId, classroomMap, errors);
    
    // Save export settings
    try {
      await supabase
        .from('export_settings')
        .upsert({
          user_id: userId,
          logo_data: DB.exportSettings.logo ? DB.exportSettings.logo.substring(0, 500000) : null, // Limit size
          logo_name: DB.exportSettings.logoName,
          logo_size: DB.exportSettings.logoSize,
          color: DB.exportSettings.color
        });
    } catch (error) {
      errors.push(error);
    }
    
    if (errors.length > 0) {
      console.error('Some saves failed:', errors);
      showToast(`⚠️ ${errors.length} items failed to sync`);
    } else {
      showToast('✅ All data saved to cloud');
    }
    
  } catch (error) {
    console.error('Fatal error saving to Supabase:', error);
    throw error;
  }
}

async function saveClassroomsData(userId, classroomMap, errors) {
  const studentBatch = [];
  const lessonBatch = [];
  const columnBatch = [];
  const gradeBatch = [];
  const attendanceBatch = [];
  
  for (const c of DB.classrooms) {
    const classroomUuid = classroomMap.get(c.id);
    if (!classroomUuid) continue;
    
    // Students
    c.students.forEach(s => {
      studentBatch.push({
        classroom_id: classroomUuid,
        student_number: s.id,
        name: s.name,
        phone: s.phone || '',
        email: s.email || '',
        parent_name: s.parentName || '',
        parent_phone: s.parentPhone || '',
        notes: s.note || ''
      });
    });
    
    // Lessons
    c.lessons.forEach(l => {
      lessonBatch.push({
        classroom_id: classroomUuid,
        lesson_number: l.id,
        title: l.topic,
        lesson_date: l.date,
        mode: l.mode || 'standard',
        student_ids: l.studentIds || []
      });
    });
    
    // Columns
    c.columns.forEach(col => {
      const lesson = c.lessons.find(l => l.id === col.lessonId);
      columnBatch.push({
        classroom_id: classroomUuid,
        lesson_id: lesson ? null : null, // Would need lesson UUID mapping
        column_number: col.id,
        name: col.name,
        ielts: col.ielts || false
      });
    });
  }
  
  // Batch insert students
  if (studentBatch.length > 0) {
    try {
      const { data: students } = await supabase
        .from('students')
        .insert(studentBatch)
        .select();
      
      // Create student number to UUID map
      const studentMap = new Map();
      students?.forEach(s => {
        studentMap.set(s.student_number, s.id);
      });
      
      // Batch insert lessons
      if (lessonBatch.length > 0) {
        const { data: lessons } = await supabase
          .from('lessons')
          .insert(lessonBatch)
          .select();
        
        // Create lesson number to UUID map
        const lessonMap = new Map();
        lessons?.forEach(l => {
          lessonMap.set(l.lesson_number, l.id);
        });
        
        // Prepare grades and attendance
        DB.classrooms.forEach(c => {
          c.lessons.forEach(l => {
            const lessonUuid = lessonMap.get(l.id);
            if (!lessonUuid) return;
            
            Object.entries(l.data || {}).forEach(([key, value]) => {
              if (key.startsWith('col_')) {
                const [, colId, studentId] = key.split('_');
                const studentUuid = studentMap.get(parseInt(studentId));
                if (studentUuid) {
                  gradeBatch.push({
                    lesson_id: lessonUuid,
                    student_id: studentUuid,
                    column_id: null, // Would need column UUID
                    grade: value
                  });
                }
              } else if (key.startsWith('att_')) {
                const studentId = key.split('_')[1];
                const studentUuid = studentMap.get(parseInt(studentId));
                if (studentUuid) {
                  attendanceBatch.push({
                    lesson_id: lessonUuid,
                    student_id: studentUuid,
                    status: value
                  });
                }
              }
            });
          });
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  
  // Batch insert grades and attendance
  if (gradeBatch.length > 0) {
    try {
      await supabase.from('grades').insert(gradeBatch);
    } catch (error) {
      errors.push(error);
    }
  }
  
  if (attendanceBatch.length > 0) {
    try {
      await supabase.from('attendance').insert(attendanceBatch);
    } catch (error) {
      errors.push(error);
    }
  }
}

// ============================================
// SAVE DB (with debounce and offline queue)
// ============================================
let _st;
let saveQueue = [];

async function saveDB(badge, immediate = false) {
  // Add to queue
  saveQueue.push({ badge, timestamp: Date.now() });
  
  const saveOperation = async () => {
    try {
      // Always save to localStorage
      saveToLocalStorage();
      
      // If online and logged in, save to cloud
      if (navigator.onLine && supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
        try {
          await saveUserDataToSupabase(DB.user.id);
          DB.pendingChanges = [];
        } catch (error) {
          console.error('Cloud save failed, queuing for later:', error);
          queuePendingChanges();
        }
      } else if (DB.user?.mode === 'supabase') {
        // Offline - queue for later
        queuePendingChanges();
      }
      
      // Show save indicator
      const lastBadge = saveQueue[saveQueue.length - 1]?.badge;
      if (lastBadge) showSave(lastBadge);
      
    } catch (e) {
      console.error('Failed to save DB', e);
    }
    
    saveQueue = [];
  };
  
  if (immediate) {
    clearTimeout(_st);
    await saveOperation();
  } else {
    clearTimeout(_st);
    _st = setTimeout(saveOperation, 150);
  }
}

function showSave(badge) {
  const el = document.getElementById('save-pill-' + badge);
  if (!el) return;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// ============================================
// OFFLINE DETECTION
// ============================================
window.addEventListener('online', () => {
  showToast('📶 Back online - syncing...');
  if (DB.user?.mode === 'supabase') {
    syncWithCloud();
  }
});

window.addEventListener('offline', () => {
  showToast('📴 Offline mode - changes saved locally');
  DB.syncStatus = 'offline';
  updateSyncUI();
});

// ============================================
// IELTS MODE
// ============================================
const IELTS_SECTIONS = ['Listening', 'Reading', 'Writing', 'Speaking', 'Overall Band'];
let currentLessonMode = 'standard';

function toggleLessonMode(mode) {
  currentLessonMode = mode;
  document.getElementById('mode-standard').classList.toggle('active', mode === 'standard');
  document.getElementById('mode-ielts').classList.toggle('ielts-active', mode === 'ielts');
  document.getElementById('mode-ielts').classList.toggle('active', mode === 'ielts');
}

// ============================================
// SCREEN NAVIGATION
// ============================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function showLanding() { showScreen('s-landing'); }
function showAuth(mode) { 
  showScreen('s-auth'); 
  authSwitchTab(mode || 'signin');
  loadAuthLogo();
}
function goHome() { showScreen('s-home'); renderClassrooms(); }
function goBackToClass() { showScreen('s-classroom'); switchTab('lessons', document.querySelector('[data-tab="lessons"]')); }
function showContact() { showScreen('s-contact'); }

// ============================================
// AUTH LOGO MANAGEMENT
// ============================================
function loadAuthLogo() {
  const logoContainer = document.getElementById('auth-logo-container');
  if (!logoContainer) return;
  
  if (DB.exportSettings && DB.exportSettings.logo) {
    logoContainer.innerHTML = `<img src="${DB.exportSettings.logo}" alt="School Logo" class="auth-logo-img" loading="lazy">`;
  } else {
    logoContainer.innerHTML = `
      <div class="logo-fallback">GJ</div>
      <p>Your School Logo</p>
    `;
  }
}

// ============================================
// AUTHENTICATION (with merge strategy)
// ============================================
let _authMode = 'signin';
function authSwitchTab(mode) {
  _authMode = mode;
  document.getElementById('tab-signin').classList.toggle('active', mode === 'signin');
  document.getElementById('tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-track').classList.toggle('show-signup', mode === 'signup');
  document.getElementById('auth-tagline').textContent = mode === 'signin' ? 'Welcome back — log in to continue' : 'Create your free teacher account';
  document.getElementById('err-signin').classList.remove('show');
  document.getElementById('err-signup').classList.remove('show');
}

function authErr(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.add('show');
}

async function authSubmit(mode) {
  if (mode === 'signin') {
    const email = document.getElementById('si-email').value.trim();
    const pass = document.getElementById('si-password').value;
    
    if (!email || !pass) { 
      authErr('err-signin', 'Please fill in all fields.'); 
      return; 
    }
    
    if (pass.length < 6) { 
      authErr('err-signin', 'Password must be at least 6 characters.'); 
      return; 
    }
    
    authErr('err-signin', '');
    
    if (supabase) {
      try {
        // Save current local data as guest data before login
        const guestData = { ...DB };
        
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password: pass
        });
        
        if (error) {
          authErr('err-signin', error.message);
          return;
        }
        
        const user = data.user;
        
        // Load cloud data
        const cloudData = await loadUserDataFromSupabase(user.id);
        
        // Merge guest data with cloud data
        DB = mergeData(guestData, cloudData, 'timestamp');
        
        // Set user
        DB.user = { 
          id: user.id,
          email: user.email, 
          name: user.user_metadata?.full_name || user.email.split('@')[0], 
          mode: 'supabase' 
        };
        
        // Save merged data everywhere
        await saveDB('home', true);
        
        // Start auto-sync
        startAutoSync();
        
        enterApp();
        
      } catch (err) {
        authErr('err-signin', err.message);
      }
      return;
    }
    
    // Fallback to local mode
    DB.user = { email, name: email.split('@')[0], mode: 'local' };
    saveDB('home', true);
    enterApp();
  }
}

function enterApp() {
  const u = DB.user;
  document.getElementById('user-name-display').textContent = u.name;
  document.getElementById('user-av').textContent = u.name.slice(0, 2).toUpperCase();
  document.getElementById('um-name').textContent = u.name;
  document.getElementById('um-email').textContent = u.email || 'Local mode';
  
  const h = new Date().getHours();
  document.getElementById('home-greeting').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + u.name.split(' ')[0] + ' 👋';
  
  showScreen('s-home');
  renderClassrooms();
  
  // Add sync indicator to topbar
  addSyncIndicator();
  
  checkOnboarding();
}

function addSyncIndicator() {
  const topbarRight = document.querySelector('.topbar-right');
  if (topbarRight && !document.getElementById('sync-indicator')) {
    const indicator = document.createElement('div');
    indicator.id = 'sync-indicator';
    indicator.className = 'sync-indicator idle';
    topbarRight.prepend(indicator);
    updateSyncUI();
  }
}

async function signOut() {
  // Stop auto-sync
  stopAutoSync();
  
  // Save any pending changes
  await saveDB('home', true);
  
  if (supabase && DB.user?.mode === 'supabase') {
    await supabase.auth.signOut();
  }
  
  // Keep a copy in localStorage but clear user
  const userData = { ...DB };
  localStorage.setItem('gj_v6_pro_last_user', JSON.stringify(userData));
  
  DB.user = null;
  DB.syncStatus = 'idle';
  
  saveToLocalStorage();
  
  closeOv('ov-user');
  showLanding();
}

// ============================================
// ONBOARDING
// ============================================
function checkOnboarding() {
  if (DB.user && !DB.user.onboardingCompleted) {
    if (DB.user.name) {
      document.getElementById('onboarding-name').value = DB.user.name;
    }
    if (DB.user.school) {
      document.getElementById('onboarding-school').value = DB.user.school;
    }
    if (DB.user.role) {
      document.getElementById('onboarding-role').value = DB.user.role;
    }
    
    setTimeout(() => {
      openOv('ov-onboarding');
    }, 500);
  }
}

async function saveOnboarding() {
  const name = v('onboarding-name');
  const school = v('onboarding-school');
  const role = document.getElementById('onboarding-role').value;
  
  if (!name) {
    shake('onboarding-name');
    return;
  }
  
  DB.user.name = name;
  DB.user.school = school;
  DB.user.role = role;
  DB.user.onboardingCompleted = true;
  
  document.getElementById('user-name-display').textContent = name;
  document.getElementById('user-av').textContent = name.slice(0, 2).toUpperCase();
  document.getElementById('um-name').textContent = name;
  
  const h = new Date().getHours();
  document.getElementById('home-greeting').textContent = 
    (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + name.split(' ')[0] + ' 👋';
  
  if (supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
    await supabase
      .from('profiles')
      .upsert({
        id: DB.user.id,
        full_name: name,
        school_name: school,
        role: role,
        onboarding_completed: true
      });
  }
  
  saveDB('home', true);
  closeOv('ov-onboarding');
}

// ============================================
// CLASSROOMS
// ============================================
const CC_ICONS = ['📐', '📚', '🔬', '✏️', '🎨', '🌍', '💻', '🎵', '🏃', '📖', '⚗️', '🧬'];

function renderClassrooms() {
  const grid = document.getElementById('classrooms-grid');
  grid.innerHTML = '';
  DB.classrooms.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'classroom-card fade-up';
    card.style.animationDelay = (i * .05) + 's';
    const icon = CC_ICONS[c.id % CC_ICONS.length];
    card.innerHTML = `<div class="cc-header"><div class="cc-icon">${icon}</div><button class="cc-del" onclick="event.stopPropagation();deleteClassConfirm('${c.id}')"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></div>
      <div class="cc-name">${esc(c.name)}</div><div class="cc-subject">${esc(c.subject || '')}${c.teacher ? ' · ' + esc(c.teacher) : ''}</div>
      <div class="cc-stats"><div><div class="cc-stat-val">${c.students.length}</div><div class="cc-stat-lbl">Students</div></div><div><div class="cc-stat-val">${c.lessons.length}</div><div class="cc-stat-lbl">Lessons</div></div><div><div class="cc-stat-val">${c.columns.length}</div><div class="cc-stat-lbl">Columns</div></div></div>`;
    card.onclick = () => openClassroom(c.id);
    grid.appendChild(card);
  });
  const nc = document.createElement('div');
  nc.className = 'new-class-card';
  nc.innerHTML = `<div class="new-class-plus">+</div><span>New Classroom</span>`;
  nc.onclick = () => openOv('ov-new-class');
  grid.appendChild(nc);
}

function createClassroom() {
  const name = v('inp-cname');
  if (!name) { shake('inp-cname'); return; }
  
  const newClass = {
    id: `class_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Use string ID
    name,
    subject: v('inp-csub'),
    teacher: v('inp-cteacher'),
    students: [],
    columns: [],
    lessons: [],
    nextSid: 1,
    nextLid: 1,
    nextCid: 1,
    updatedAt: new Date().toISOString()
  };
  
  DB.classrooms.push(newClass);
  DB.nextId = Math.max(DB.nextId, parseInt(newClass.id.split('_')[1] || '0') + 1);
  
  rebuildIndex();
  saveDB('home');
  closeOv('ov-new-class');
  clrInputs(['inp-cname', 'inp-csub', 'inp-cteacher']);
  renderClassrooms();
  toast('Classroom created!');
}

function deleteClassConfirm(id) {
  const c = getC(id);
  confirm_(`Delete "${c.name}"?`, 'All students, lessons, and grades will be permanently deleted.', () => {
    DB.classrooms = DB.classrooms.filter(c => c.id !== id);
    rebuildIndex();
    saveDB('home', true);
    renderClassrooms();
    toast('Deleted.');
  });
}

function openClassroom(id) {
  CID = id;
  const c = CC();
  document.getElementById('class-crumb').textContent = c.name;
  document.getElementById('lesson-back-label').textContent = c.name;
  showScreen('s-classroom');
  switchTab('students', document.querySelector('[data-tab="students"]'));
  renderStudents();
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const p = document.getElementById('tp-' + name);
  if (p) p.classList.add('active');
  if (name === 'students') renderStudents();
  if (name === 'lessons') renderLessons();
  if (name === 'analytics') renderAnalytics();
}

// ============================================
// STUDENTS
// ============================================
let editSid = null;

function openAddStudent() {
  editSid = null;
  document.getElementById('ov-stu-title').textContent = 'Add Student';
  document.getElementById('stu-save-btn').textContent = 'Add Student';
  clrInputs(['inp-sname', 'inp-sphone', 'inp-semail', 'inp-pname', 'inp-pphone', 'inp-snote']);
  openOv('ov-student');
}

function openEditStudent(sid) {
  editSid = sid;
  const s = getStudent(CID, sid);
  if (!s) return;
  
  document.getElementById('ov-stu-title').textContent = 'Edit Student';
  document.getElementById('stu-save-btn').textContent = 'Save';
  sv('inp-sname', s.name);
  sv('inp-sphone', s.phone || '');
  sv('inp-semail', s.email || '');
  sv('inp-pname', s.parentName || '');
  sv('inp-pphone', s.parentPhone || '');
  sv('inp-snote', s.note || '');
  openOv('ov-student');
}

function saveStudent() {
  const name = v('inp-sname');
  if (!name) { shake('inp-sname'); return; }
  
  const data = {
    name,
    phone: v('inp-sphone'),
    email: v('inp-semail'),
    parentName: v('inp-pname'),
    parentPhone: v('inp-pphone'),
    note: v('inp-snote'),
    updatedAt: new Date().toISOString()
  };
  
  const c = CC();
  if (editSid !== null) {
    const student = c.students.find(s => s.id === editSid);
    if (student) {
      Object.assign(student, data);
    }
    toast('Student updated!');
  } else {
    const newId = c.nextSid++;
    c.students.push({ id: newId, ...data });
    toast('Student added!');
  }
  
  rebuildIndex();
  saveDB('class');
  closeOv('ov-student');
  renderStudents();
  
  if (document.getElementById('sheet-ov').classList.contains('open')) {
    openStudentSheet(editSid || c.students[c.students.length - 1].id);
  }
}

function studentStats(sid) {
  const c = CC();
  let present = 0, late = 0, absent = 0;
  
  c.lessons.forEach(l => {
    if (l.studentIds && !l.studentIds.includes(sid)) {
      return;
    }
    
    const val = (l.data || {})[`att_${sid}`] || 'present';
    if (val === 'present') present++;
    else if (val === 'late') late++;
    else absent++;
  });
  
  return { 
    present, 
    late, 
    absent, 
    attended: present + late, 
    total: c.lessons.filter(l => !l.studentIds || l.studentIds.includes(sid)).length 
  };
}

function renderStudents() {
  const c = CC();
  const list = document.getElementById('students-list');
  document.getElementById('students-count').textContent = c.students.length;
  document.getElementById('tbadge-students').textContent = c.students.length;
  list.innerHTML = '';
  
  const sorted = [...c.students].sort((a, b) => a.name.localeCompare(b.name));
  if (!sorted.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><div class="empty-title">No students yet</div><div class="empty-desc">Add students using the button above.</div></div>`;
    return;
  }
  
  sorted.forEach((s, i) => {
    const st = studentStats(s.id);
    const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const el = document.createElement('div');
    el.className = 'student-item fade-up';
    el.style.animationDelay = (i * .04) + 's';
    el.innerHTML = `<div class="s-avatar">${esc(initials)}</div>
      <div class="s-info"><div class="s-name">${esc(s.name)}</div>
        <div class="s-meta">${s.phone ? `<span class="s-meta-item">📱 ${esc(s.phone)}</span>` : ''}${s.parentPhone ? `<span class="s-meta-item">👨‍👩‍👧 ${esc(s.parentPhone)}</span>` : ''}${s.note ? `<span class="s-meta-item">📝 ${esc(s.note)}</span>` : ''}</div></div>
      <div class="s-att-pills">${st.total > 0 ? `<span class="pill pill-green">✓ ${st.present}</span>${st.late > 0 ? `<span class="pill pill-amber">⏰ ${st.late}</span>` : ''}${st.absent > 0 ? `<span class="pill pill-red">✗ ${st.absent}</span>` : ''}` :
        '<span style="font-size:11px;color:var(--text-light)">No lessons</span>'}</div>
      <div class="s-actions">
        <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();openStudentSheet(${s.id})">View</button>
        <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();openEditStudent(${s.id})">Edit</button>
        <button class="icon-btn" style="width:28px;height:28px" onclick="event.stopPropagation();delStudentConfirm(${s.id})"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>`;
    el.onclick = () => openStudentSheet(s.id);
    list.appendChild(el);
  });
}

function delStudentConfirm(sid) {
  const s = getStudent(CID, sid);
  if (!s) return;
  
  confirm_(`Remove "${s.name}"?`, 'All attendance and grades for this student will be removed.', () => {
    const c = CC();
    c.students = c.students.filter(s => s.id !== sid);
    rebuildIndex();
    saveDB('class', true);
    renderStudents();
    toast('Student removed.');
  });
}

// STUDENT SHEET
function openStudentSheet(sid) {
  const c = CC(), s = getStudent(CID, sid);
  if (!s) return;
  
  const st = studentStats(sid);
  const rate = st.total > 0 ? Math.round(st.attended / st.total * 100) : 100;
  const rateColor = rate >= 80 ? 'var(--success)' : rate >= 60 ? 'var(--warning)' : 'var(--error)';
  const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  
  const hist = c.lessons.slice().reverse().map(l => {
    const val = (l.data || {})[`att_${s.id}`] || 'present';
    const lbl = { present: 'Present', late: 'Late', absent: 'Absent' };
    return `<div class="history-row"><div class="history-date">${l.date}</div><div class="history-topic">${esc(l.topic || '(no topic)')}</div><span class="pill pill-${val === 'present' ? 'green' : val === 'late' ? 'amber' : 'red'}">${lbl[val]}</span></div>`;
  }).join('') || '<p style="font-size:13px;color:var(--text-light)">No lessons recorded yet.</p>';

  document.getElementById('sheet-content').innerHTML = `
    <div class="sheet-hdr">
      <div class="sheet-av" id="sh-av">${esc(initials)}</div>
      <div style="flex:1"><div class="sheet-name" id="sh-name">${esc(s.name)}</div><div class="sheet-class-name">${esc(c.name)}</div></div>
      <button class="sheet-x" onclick="closeSheet()">×</button>
    </div>
    <div class="sheet-sec">
      <div class="sheet-sec-title">Contact Info <span style="font-size:9px;color:var(--accent);font-weight:500;margin-left:6px;text-transform:none;letter-spacing:0">click any field to edit</span></div>
      <div class="info-grid">
        ${icard(sid, 'name', 'Name', s.name)}
        ${icard(sid, 'phone', 'Student Phone', s.phone || '')}
        ${icard(sid, 'email', 'Email', s.email || '')}
        ${icard(sid, 'parentName', 'Parent / Guardian', s.parentName || '')}
        ${icard(sid, 'parentPhone', 'Parent Phone', s.parentPhone || '')}
        ${icard(sid, 'note', 'Notes', s.note || '')}
      </div>
    </div>
    <div class="sheet-sec">
      <div class="sheet-sec-title">Attendance Summary</div>
      <div class="info-grid">
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Total Lessons</div><div class="info-card-val">${st.total}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Attendance Rate</div><div class="info-card-val" style="color:${rateColor}">${rate}%</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Present</div><div class="info-card-val" style="color:var(--success)">${st.present}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Late (attended)</div><div class="info-card-val" style="color:var(--warning)">${st.late}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Absent</div><div class="info-card-val" style="color:var(--error)">${st.absent}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Days Attended</div><div class="info-card-val">${st.attended}</div></div>
      </div>
    </div>
    <div class="sheet-sec"><div class="sheet-sec-title">Lesson History</div>${hist}</div>
    <button class="btn btn-danger" style="width:100%;justify-content:center" onclick="delStudentConfirm(${sid});closeSheet()">Remove Student</button>`;
  document.getElementById('sheet-ov').classList.add('open');
}

function icard(sid, field, label, val) {
  const display = val ? esc(val) : `<span class="empty">—</span>`;
  return `<div class="info-card" onclick="editField(this,${sid},'${field}')">
    <div class="info-card-label">${label}<span class="edit-hint">✎ edit</span></div>
    <div class="info-card-val">${display}</div>
  </div>`;
}

function editField(card, sid, field) {
  if (card.classList.contains('editing')) return;
  card.classList.add('editing');
  const valDiv = card.querySelector('.info-card-val');
  const s = getStudent(CID, sid);
  if (!s) return;
  
  const cur = s[field] || '';
  valDiv.innerHTML = `<input class="info-card-input" value="${esc(cur)}" placeholder="—">`;
  const inp = valDiv.querySelector('input');
  inp.focus();
  inp.select();
  
  function commit() {
    const nv = inp.value.trim();
    s[field] = nv;
    s.updatedAt = new Date().toISOString();
    saveDB('class');
    card.classList.remove('editing');
    valDiv.innerHTML = nv ? esc(nv) : '<span class="empty">—</span>';
    if (field === 'name') {
      const shn = document.getElementById('sh-name');
      if (shn) shn.textContent = nv || s.name;
      const shav = document.getElementById('sh-av');
      if (shav) shav.textContent = nv.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
      renderStudents();
    }
  }
  
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { 
      card.classList.remove('editing'); 
      valDiv.innerHTML = cur ? esc(cur) : '<span class="empty">—</span>'; 
    }
  };
  inp.onblur = commit;
}

function closeSheet() { document.getElementById('sheet-ov').classList.remove('open'); }
function closeSheetIfBg(e) { if (e.target === document.getElementById('sheet-ov')) closeSheet(); }

// ============================================
// LESSONS
// ============================================
function openAddLesson() {
  currentLessonMode = 'standard';
  toggleLessonMode('standard');
  document.getElementById('inp-ldate').value = todayStr();
  document.getElementById('inp-ltopic').value = '';
  document.getElementById('inp-lnum').value = '';
  openOv('ov-lesson');
}

function saveLesson() {
  const topic = v('inp-ltopic');
  if (!topic) { shake('inp-ltopic'); return; }
  const date = document.getElementById('inp-ldate').value || todayStr();
  const c = CC();
  const num = parseInt(document.getElementById('inp-lnum').value) || c.lessons.length + 1;

  const lesson = { 
    id: c.nextLid++, 
    topic, 
    date, 
    num, 
    data: {}, 
    mode: currentLessonMode,
    studentIds: c.students.map(s => s.id),
    updatedAt: new Date().toISOString()
  };

  if (currentLessonMode === 'ielts') {
    IELTS_SECTIONS.forEach(sec => {
      if (sec !== 'Overall Band') {
        c.columns.push({ 
          id: c.nextCid++, 
          name: sec, 
          ielts: true, 
          lessonId: lesson.id,
          updatedAt: new Date().toISOString()
        });
      }
    });
  }

  c.lessons.push(lesson);
  LID = lesson.id;
  
  rebuildIndex();
  saveDB('class');
  closeOv('ov-lesson');
  renderLessons();
  document.getElementById('tbadge-lessons').textContent = c.lessons.length;
  toast(currentLessonMode === 'ielts' ? '🎯 IELTS lesson created!' : 'Lesson created!');
}

let editLid = null;
function openEditLesson(lid) {
  editLid = lid;
  const l = getLesson(CID, lid);
  if (!l) return;
  
  sv('inp-el-topic', l.topic);
  sv('inp-el-date', l.date);
  document.getElementById('inp-el-num').value = l.num || '';
  openOv('ov-edit-lesson');
}

function confirmEditLesson() {
  const topic = v('inp-el-topic');
  if (!topic) { shake('inp-el-topic'); return; }
  
  const l = getLesson(CID, editLid);
  if (!l) return;
  
  l.topic = topic;
  l.date = v('inp-el-date') || l.date;
  l.num = parseInt(document.getElementById('inp-el-num').value) || l.num;
  l.updatedAt = new Date().toISOString();
  
  saveDB('class');
  closeOv('ov-edit-lesson');
  renderLessons();
  if (LID === editLid) renderLessonHeader();
}

function renderLessons() {
  const c = CC();
  const list = document.getElementById('lessons-list');
  document.getElementById('lessons-count').textContent = c.lessons.length;
  document.getElementById('tbadge-lessons').textContent = c.lessons.length;
  list.innerHTML = '';
  
  if (!c.lessons.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-title">No lessons yet</div><div class="empty-desc">Create a lesson to start recording attendance and grades.</div></div>`;
    return;
  }
  
  const sorted = [...c.lessons].sort((a, b) => b.date.localeCompare(b.date) || b.id - a.id);
  sorted.forEach((l, i) => {
    let p = 0, la = 0, ab = 0;
    c.students.forEach(s => {
      if (l.studentIds && !l.studentIds.includes(s.id)) return;
      
      const val = (l.data || {})[`att_${s.id}`] || 'present';
      if (val === 'present') p++;
      else if (val === 'late') la++;
      else ab++;
    });
    
    const el = document.createElement('div');
    el.className = 'lesson-item fade-up' + (l.mode === 'ielts' ? ' ielts-lesson' : '');
    el.style.animationDelay = (i * .04) + 's';
    el.innerHTML = `<div class="lesson-number">${l.num || i + 1}</div>
      <div class="lesson-info">
        <div class="lesson-name">${esc(l.topic)}${l.mode === 'ielts' ? '<span class="ielts-badge" style="margin-left:8px">🎯 IELTS</span>' : ''}</div>
        <div class="lesson-date-row"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span>${l.date}</span><span style="color:var(--border)">·</span><span>${l.studentIds ? l.studentIds.length : c.students.length} students</span></div></div>
      ${c.students.length > 0 ? `<div class="lesson-att-mini"><div class="att-dot p">${p}</div>${la > 0 ? `<div class="att-dot l">${la}</div>` : ''}${ab > 0 ? `<div class="att-dot a">${ab}</div>` : ''}</div>` : ''}
      <button style="background:none;border:none;cursor:pointer;padding:4px 7px;color:var(--text-light);border-radius:6px" onclick="event.stopPropagation();openEditLesson(${l.id})"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
      <button class="lesson-del" onclick="event.stopPropagation();delLessonConfirm(${l.id})">×</button>
      <span class="lesson-arrow">→</span>`;
    el.onclick = () => openLesson(l.id);
    list.appendChild(el);
  });
}

function delLessonConfirm(lid) {
  const l = getLesson(CID, lid);
  if (!l) return;
  
  confirm_(`Delete lesson "${l.topic}"?`, 'All attendance and grade data for this lesson will be lost.', () => {
    const c = CC();
    c.columns = c.columns.filter(col => col.lessonId !== lid);
    c.lessons = c.lessons.filter(l => l.id !== lid);
    
    if (LID === lid) LID = null;
    
    rebuildIndex();
    saveDB('class', true);
    renderLessons();
    toast('Lesson deleted.');
  });
}

// ============================================
// GRADEBOOK
// ============================================
function openLesson(lid) {
  LID = lid;
  const l = CL();
  if (!l) return;
  
  if (l.mode === 'ielts') {
    document.getElementById('add-col-btn').style.display = 'none';
  } else {
    document.getElementById('add-col-btn').style.display = 'inline-flex';
  }
  renderLessonHeader();
  renderGradebook();
  showScreen('s-lesson');
}

function renderLessonHeader() {
  const l = CL();
  if (!l) return;
  document.getElementById('lgb-name').textContent = l.topic;
  document.getElementById('lgb-date').textContent = l.date + (l.num ? ` · Lesson ${l.num}` : '') + (l.mode === 'ielts' ? ' · IELTS Mode' : '');
  document.getElementById('lesson-crumb').textContent = l.topic;
}

function getBandClass(score) {
  if (!score || score === '-') return '';
  const n = parseFloat(score);
  if (isNaN(n)) return '';
  if (n >= 9) return 'band-9';
  if (n >= 8) return 'band-8';
  if (n >= 7) return 'band-7';
  if (n >= 6) return 'band-6';
  if (n >= 5) return 'band-5';
  return 'band-low';
}

function calculateOverallBand(sid) {
  const c = CC(), l = CL();
  if (!l || l.mode !== 'ielts') return '-';
  
  if (l.studentIds && !l.studentIds.includes(sid)) {
    return '-';
  }

  const cols = c.columns.filter(col => col.ielts && col.lessonId === l.id && col.name !== 'Overall Band');
  let sum = 0, count = 0;

  cols.forEach(col => {
    const val = (l.data || {})[`col_${col.id}_${sid}`];
    if (val && val.trim()) {
      const n = parseFloat(val);
      if (!isNaN(n)) { sum += n; count++; }
    }
  });

  if (count === 0) return '-';
  const avg = sum / count;
  return avg.toFixed(1);
}

function renderGradebook() {
  const c = CC(), l = CL();
  if (!l) return;
  
  const sorted = [...c.students]
    .filter(s => l.studentIds ? l.studentIds.includes(s.id) : true)
    .sort((a, b) => a.name.localeCompare(b.name));
  
  let p = 0, la = 0, ab = 0;
  sorted.forEach(s => {
    const val = (l.data || {})[`att_${s.id}`] || 'present';
    if (val === 'present') p++;
    else if (val === 'late') la++;
    else ab++;
  });

  const strip = document.getElementById('stats-strip');
  const total = sorted.length;
  const attended = p + la;
  const rate = total > 0 ? Math.round(attended / total * 100) : 100;
  
  strip.innerHTML = `
    <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--success)"></div>Present: ${p}</div>
    <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--warning)"></div>Late: ${la}</div>
    <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--error)"></div>Absent: ${ab}</div>
    <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--accent)"></div>Attendance Rate: ${rate}%</div>
    <div class="stat-chip">Total Students: ${total}</div>`;

  const lessonCols = l.mode === 'ielts' ? c.columns.filter(col => col.ielts && col.lessonId === l.id) : c.columns.filter(col => !col.ielts);

  const head = document.getElementById('gb-head');
  head.innerHTML = `<tr>
    <th class="th-student">Student</th>
    <th style="width:130px">Attendance</th>
    ${lessonCols.map(col => {
      if (col.name === 'Overall Band') {
        return `<th class="overall-band-col" style="min-width:120px"><div class="th-inner-flex"><span>⭐ Overall Band</span></div></th>`;
      }
      return `<th><div class="th-inner-flex"><span>${esc(col.name)}</span>${!col.ielts ? `<div class="th-col-actions"><button class="th-col-btn" onclick="openRenameColumn(${col.id})" title="Rename">✎</button><button class="th-col-btn" onclick="delColumnConfirm(${col.id})" title="Delete">×</button></div>` : ''}</div></th>`;
    }).join('')}
  </tr>`;

  const body = document.getElementById('gb-body');
  body.innerHTML = '';

  sorted.forEach(s => {
    const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const attVal = (l.data || {})[`att_${s.id}`] || 'present';
    const attLabel = { present: 'Present', late: 'Late', absent: 'Absent' };
    const attClass = { present: 'present', late: 'late', absent: 'absent' };
    const absent = attVal === 'absent';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-student"><div class="td-student-inner"><div class="td-mini-av">${esc(initials)}</div><div class="td-name-text">${esc(s.name)}</div></div></td>
      <td class="td-att-cell"><div class="att-chip ${attClass[attVal]}" onclick="cycleAtt(${s.id})">${attLabel[attVal]}</div></td>
      ${lessonCols.map(col => {
        if (col.name === 'Overall Band') {
          const overall = calculateOverallBand(s.id);
          return `<td class="overall-band-cell">${overall}</td>`;
        }
        const val = esc((l.data || {})[`col_${col.id}_${s.id}`] || '');
        if (l.mode === 'ielts' && col.ielts) {
          const bandClass = getBandClass(val);
          return `<td class="band-score-cell"><input class="grade-inp" type="text" placeholder="—" value="${val}" onchange="saveGrade(${col.id},${s.id},this.value)" style="text-align:center" ${absent ? 'disabled' : ''}></td>`;
        }
        return `<td><input class="grade-inp" type="text" placeholder="—" value="${val}" onchange="saveGrade(${col.id},${s.id},this.value)" ${absent ? 'disabled' : ''}></td>`;
      }).join('')}`;
    body.appendChild(tr);
  });

  const addTr = document.createElement('tr');
  addTr.className = 'add-student-row';
  addTr.innerHTML = `<td class="td-student" colspan="${2 + lessonCols.length}"><input class="add-row-inp" placeholder="+ Type student name and press Enter to add to THIS lesson..." onkeydown="if(event.key==='Enter')quickAddStudentToLesson(this.value)"></td>`;
  body.appendChild(addTr);
}

function cycleAtt(sid) {
  const l = CL();
  if (!l) return;
  
  const key = `att_${sid}`;
  const cur = (l.data || {})[key] || 'present';
  const next = { present: 'late', late: 'absent', absent: 'present' };
  
  if (!l.data) l.data = {};
  l.data[key] = next[cur];
  l.updatedAt = new Date().toISOString();
  
  saveDB('lesson');
  renderGradebook();
  renderStudents();
}

function saveGrade(cid, sid, val) {
  const l = CL();
  if (!l) return;
  
  if (!l.data) l.data = {};
  l.data[`col_${cid}_${sid}`] = val.trim();
  l.updatedAt = new Date().toISOString();
  
  saveDB('lesson');
  if (l.mode === 'ielts') {
    renderGradebook();
  }
}

function quickAddStudentToLesson(name) {
  name = name.trim();
  if (!name) return;
  
  const c = CC();
  const l = CL();
  
  const newStudent = { 
    id: c.nextSid++, 
    name, 
    phone: '', 
    email: '', 
    parentName: '', 
    parentPhone: '', 
    note: '',
    updatedAt: new Date().toISOString()
  };
  c.students.push(newStudent);
  
  if (l.studentIds) {
    l.studentIds.push(newStudent.id);
  }
  
  l.updatedAt = new Date().toISOString();
  
  rebuildIndex();
  saveDB('class');
  renderGradebook();
  renderStudents();
  toast(`✅ Student added to this lesson and class roster!`);
}

// ============================================
// COLUMNS
// ============================================
function openAddColumn() {
  document.getElementById('inp-colname').value = '';
  openOv('ov-column');
}

function saveColumn() {
  const name = v('inp-colname');
  if (!name) { shake('inp-colname'); return; }
  
  const c = CC();
  c.columns.push({ 
    id: c.nextCid++, 
    name,
    updatedAt: new Date().toISOString()
  });
  
  rebuildIndex();
  saveDB('class');
  closeOv('ov-column');
  renderGradebook();
  toast('Column added!');
}

let renameColId = null;
function openRenameColumn(cid) {
  renameColId = cid;
  const col = getColumn(CID, cid);
  if (!col) return;
  
  document.getElementById('inp-rename-col').value = col.name;
  openOv('ov-rename-col');
}

function confirmRenameCol() {
  const name = v('inp-rename-col');
  if (!name) { shake('inp-rename-col'); return; }
  
  const col = getColumn(CID, renameColId);
  if (!col) return;
  
  col.name = name;
  col.updatedAt = new Date().toISOString();
  
  saveDB('class');
  closeOv('ov-rename-col');
  renderGradebook();
  toast('Column renamed!');
}

function delColumnConfirm(cid) {
  const col = getColumn(CID, cid);
  if (!col) return;
  
  confirm_(`Delete column "${col.name}"?`, 'All grades in this column will be permanently deleted.', () => {
    const c = CC();
    c.columns = c.columns.filter(c => c.id !== cid);
    rebuildIndex();
    saveDB('class', true);
    renderGradebook();
    toast('Column deleted.');
  });
}

// ============================================
// ANALYTICS
// ============================================
function renderAnalytics() {
  const c = CC();
  const scroll = document.getElementById('analytics-scroll');

  if (!c.students.length) {
    scroll.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-title">No data yet</div><div class="empty-desc">Add students and lessons to see analytics.</div></div>`;
    return;
  }

  let totalP = 0, totalL = 0, totalA = 0, totalLessons = 0;
  
  const rows = c.students.map(s => {
    const st = studentStats(s.id);
    totalP += st.present; 
    totalL += st.late; 
    totalA += st.absent;
    totalLessons += st.total;
    
    const rate = st.total > 0 ? Math.round(st.attended / st.total * 100) : 100;
    const rateColor = rate >= 80 ? 'var(--success)' : rate >= 60 ? 'var(--warning)' : 'var(--error)';
    return { 
      name: s.name, 
      rate, 
      attended: st.attended, 
      total: st.total, 
      rateColor, 
      present: st.present, 
      late: st.late, 
      absent: st.absent 
    };
  }).sort((a, b) => b.rate - a.rate);

  const avgRate = totalLessons > 0 ? Math.round((totalP + totalL) / totalLessons * 100) : 100;

  scroll.innerHTML = `
    <div class="analytics-grid">
      <div class="astat-card"><div class="astat-val">${c.lessons.length}</div><div class="astat-lbl">Total Lessons</div></div>
      <div class="astat-card"><div class="astat-val">${c.students.length}</div><div class="astat-lbl">Total Students</div></div>
      <div class="astat-card"><div class="astat-val">${avgRate}%</div><div class="astat-lbl">Avg Attendance</div></div>
      <div class="astat-card"><div class="astat-val">${totalP}</div><div class="astat-lbl">Total Present</div></div>
      <div class="astat-card"><div class="astat-val">${totalL}</div><div class="astat-lbl">Total Late</div></div>
      <div class="astat-card"><div class="astat-val">${totalA}</div><div class="astat-lbl">Total Absent</div></div>
    </div>
    <table class="att-table">
      <thead><tr><th>Student</th><th>Rate</th><th>Attended</th><th>Present</th><th>Late</th><th>Absent</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td style="font-weight:600">${esc(r.name)}</td>
        <td><div class="rate-bar-wrap"><div class="rate-bar"><div class="rate-bar-fill" style="width:${r.rate}%;background:${r.rateColor}"></div></div><span style="font-weight:700;color:${r.rateColor}">${r.rate}%</span></div></td>
        <td>${r.attended}/${r.total}</td>
        <td style="color:var(--success)">${r.present}</td>
        <td style="color:var(--warning)">${r.late}</td>
        <td style="color:var(--error)">${r.absent}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

// ============================================
// EXPORT FUNCTIONS
// ============================================
let currentExportContext = null;

function exportClass() {
  currentExportContext = { type: 'class', id: CID };
  openOv('ov-export');
}

function exportLesson() {
  currentExportContext = { type: 'lesson', id: LID };
  openOv('ov-export');
}

// PDF EXPORT (with error handling and timeout)
async function exportPDF() {
  if (!currentExportContext) return;
  closeOv('ov-export');
  toast('✨ Generating professional PDF...');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const settings = DB.exportSettings || { color: { h: 30, s: 60, l: 50, a: 100 } };
    const accentColor = `hsl(${settings.color.h}, ${settings.color.s}%, 50%)`;
    
    let payload = {};
    
    if (currentExportContext.type === 'lesson') {
      const lesson = CL();
      const classroom = CC();
      
      const cols = lesson.mode === 'ielts' 
        ? classroom.columns.filter(col => col.ielts && col.lessonId === lesson.id)
        : classroom.columns.filter(col => !col.ielts);
      
      const students = [...classroom.students]
        .filter(s => lesson.studentIds ? lesson.studentIds.includes(s.id) : true)
        .sort((a, b) => a.name.localeCompare(b.name));
      
      const rows = students.map(s => {
        const att = (lesson.data || {})[`att_${s.id}`] || 'present';
        const grades = cols.map(col => {
          if (col.name === 'Overall Band') {
            return calculateOverallBand(s.id);
          }
          return (lesson.data || {})[`col_${col.id}_${s.id}`] || '';
        });
        
        return {
          studentName: s.name,
          attendance: att,
          grades
        };
      });
      
      payload = {
        type: 'lesson',
        className: classroom.name,
        lessonName: lesson.topic,
        lessonDate: lesson.date,
        columns: cols.map(c => c.name),
        rows,
        logoData: settings.logo ? settings.logo.substring(0, 500000) : null, // Limit size
        accentColor,
        institutionName: DB.user?.name || 'GradeJournal'
      };
      
    } else {
      const classroom = getC(currentExportContext.id);
      
      const rows = [...classroom.students]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(s => {
          const stats = studentStats(s.id);
          const rate = stats.total > 0 ? Math.round(stats.attended / stats.total * 100) : 100;
          
          return {
            name: s.name,
            phone: s.phone || '',
            email: s.email || '',
            parentName: s.parentName || '',
            parentPhone: s.parentPhone || '',
            attendanceRate: rate
          };
        });
      
      payload = {
        type: 'class',
        className: classroom.name,
        teacherName: classroom.teacher || 'Teacher',
        subject: classroom.subject || 'Class',
        totalLessons: classroom.lessons.length,
        rows,
        logoData: settings.logo ? settings.logo.substring(0, 500000) : null,
        accentColor
      };
    }
    
    const endpoint = currentExportContext.type === 'lesson'
      ? `${API_BASE}/api/export/pdf/lesson`
      : `${API_BASE}/api/export/pdf/class`;
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Export failed');
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `GradeJournal-${currentExportContext.type}-${Date.now()}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    toast('✅ Professional PDF downloaded!');
    
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('PDF export error:', err);
    
    if (err.name === 'AbortError') {
      toast('❌ PDF export timed out. Please try again.');
    } else {
      toast('❌ PDF export failed. Please try again.');
    }
  }
}

// EXCEL EXPORT
async function exportExcel() {
  if (!currentExportContext) return;
  closeOv('ov-export');
  toast('📊 Generating Excel...');

  try {
    let payload = {};
    
    if (currentExportContext.type === 'lesson') {
      const lesson = CL();
      const classroom = CC();
      
      const cols = lesson.mode === 'ielts' 
        ? classroom.columns.filter(col => col.ielts && col.lessonId === lesson.id)
        : classroom.columns.filter(col => !col.ielts);
      
      const students = [...classroom.students]
        .filter(s => lesson.studentIds ? lesson.studentIds.includes(s.id) : true)
        .sort((a, b) => a.name.localeCompare(b.name));
      
      const rows = students.map(s => {
        const att = (lesson.data || {})[`att_${s.id}`] || 'present';
        const grades = cols.map(col => {
          if (col.name === 'Overall Band') {
            return calculateOverallBand(s.id);
          }
          return (lesson.data || {})[`col_${col.id}_${s.id}`] || '';
        });
        
        return {
          studentName: s.name,
          attendance: att,
          grades
        };
      });
      
      payload = {
        type: 'lesson',
        className: classroom.name,
        lessonName: lesson.topic,
        lessonDate: lesson.date,
        columns: cols.map(c => c.name),
        rows
      };
      
    } else {
      const classroom = getC(currentExportContext.id);
      
      const rows = [...classroom.students]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(s => {
          const stats = studentStats(s.id);
          const rate = stats.total > 0 ? Math.round(stats.attended / stats.total * 100) : 100;
          
          return {
            name: s.name,
            phone: s.phone || '',
            email: s.email || '',
            parentName: s.parentName || '',
            parentPhone: s.parentPhone || '',
            attendanceRate: rate
          };
        });
      
      payload = {
        type: 'class',
        className: classroom.name,
        rows
      };
    }
    
    const response = await fetch(`${API_BASE}/api/export/excel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Export failed');
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `GradeJournal-${currentExportContext.type}-${Date.now()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    toast('✅ Excel downloaded!');
    
  } catch (err) {
    console.error('Excel export error:', err);
    toast('❌ Excel export failed');
  }
}

// ============================================
// BACKUP & RESTORE
// ============================================
function backupData() {
  try {
    const dataStr = JSON.stringify(DB, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `gradejournal-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast('✅ Backup downloaded!');
  } catch (error) {
    console.error('Backup failed:', error);
    toast('❌ Backup failed');
  }
}

function restoreFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        
        confirm_('Restore Backup', 'This will replace all current data. Continue?', async () => {
          DB = backup;
          rebuildIndex();
          
          // Ensure exportSettings exists
          if (!DB.exportSettings) {
            DB.exportSettings = { color: { h: 30, s: 60, l: 50, a: 100 } };
          }
          
          await saveDB('home', true);
          
          if (supabase && DB.user?.mode === 'supabase') {
            await syncWithCloud();
          }
          
          toast('✅ Data restored!');
          renderClassrooms();
        });
      } catch (error) {
        console.error('Restore failed:', error);
        toast('❌ Invalid backup file');
      }
    };
    reader.readAsText(file);
  };
  
  input.click();
}

// ============================================
// EXPORT SETTINGS
// ============================================
let colorPickerState = { h: 30, s: 60, l: 50, a: 100 };
let colorPickerListenersAttached = false;

function openExportSettings() {
  closeOv('ov-export');

  if (!DB.exportSettings) {
    DB.exportSettings = { color: { h: 30, s: 60, l: 50, a: 100 } };
  }
  
  const previewZone = document.getElementById('file-preview-zone');
  const logoPreview = document.getElementById('export-logo-preview');
  const fileName = document.getElementById('file-preview-name');
  const fileSize = document.getElementById('file-preview-size');
  
  if (DB.exportSettings.logo) {
    logoPreview.src = DB.exportSettings.logo;
    fileName.textContent = DB.exportSettings.logoName || 'company-logo.png';
    fileSize.textContent = DB.exportSettings.logoSize || '120 KB';
    previewZone.classList.add('show');
  } else {
    previewZone.classList.remove('show');
    logoPreview.src = '';
  }
  
  const col = DB.exportSettings.color || { h: 30, s: 60, l: 50, a: 100 };
  colorPickerState = { ...col };
  
  document.getElementById('hue-slider').value = col.h;
  document.getElementById('sat-slider').value = col.s;
  document.getElementById('light-slider').value = col.l;
  document.getElementById('opacity-slider').value = col.a;
  
  updateColorDisplay();
  openOv('ov-export-settings');
}

function setupDragAndDrop() {
  const dropZone = document.getElementById('file-upload-zone');
  if (!dropZone) return;
  
  const handlers = {
    dragenter: (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); },
    dragover: (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); },
    dragleave: (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over'); },
    drop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length) {
        handleLogoFile(files[0]);
      }
    }
  };
  
  // Remove old listeners and add new ones
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.removeEventListener(eventName, handlers[eventName]);
    dropZone.addEventListener(eventName, handlers[eventName], false);
  });
}

function onExportLogoFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  handleLogoFile(file);
}

function handleLogoFile(file) {
  if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
    toast('❌ Please upload PNG or JPEG only');
    return;
  }
  
  if (file.size > 2 * 1024 * 1024) { // Reduced to 2MB max
    toast('❌ File too large. Max 2MB');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = (event) => {
    // Compress image if needed
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Max dimensions
      const maxWidth = 400;
      const maxHeight = 400;
      let width = img.width;
      let height = img.height;
      
      if (width > height) {
        if (width > maxWidth) {
          height *= maxWidth / width;
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width *= maxHeight / height;
          height = maxHeight;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      
      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);
      
      document.getElementById('export-logo-preview').src = compressedDataUrl;
      document.getElementById('file-preview-name').textContent = file.name;
      document.getElementById('file-preview-size').textContent = formatFileSize(file.size);
      document.getElementById('file-preview-zone').classList.add('show');
      
      DB.exportSettings.logo = compressedDataUrl;
      DB.exportSettings.logoName = file.name;
      DB.exportSettings.logoSize = formatFileSize(file.size);
      saveDB('home');
      toast('✓ Logo uploaded');
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function removeExportLogo() {
  document.getElementById('export-logo-file').value = '';
  document.getElementById('file-preview-zone').classList.remove('show');
  document.getElementById('export-logo-preview').src = '';
  
  if (DB.exportSettings) {
    delete DB.exportSettings.logo;
    delete DB.exportSettings.logoName;
    delete DB.exportSettings.logoSize;
    saveDB('home');
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function toggleColorPicker() {
  const dropdown = document.getElementById('color-picker-dropdown');
  if (!dropdown) return;
  
  const isVisible = dropdown.classList.contains('show');
  
  if (isVisible) {
    dropdown.classList.remove('show');
    // Clean up global listeners
    document.onmousemove = null;
    document.onmouseup = null;
  } else {
    dropdown.classList.add('show');
    setTimeout(() => setupColorGradient(), 50);
  }
}

function setupColorGradient() {
  const gradientBar = document.getElementById('color-gradient-bar');
  const cursor = document.getElementById('color-cursor');
  if (!gradientBar || !cursor) return;
  
  updateGradientBackground();
  cursor.style.left = colorPickerState.s + '%';
  cursor.style.top = (100 - colorPickerState.l) + '%';
  
  let isDragging = false;
  
  const updateFromMouse = (e) => {
    const rect = gradientBar.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    
    x = Math.max(0, Math.min(x, rect.width));
    y = Math.max(0, Math.min(y, rect.height));
    
    colorPickerState.s = Math.round((x / rect.width) * 100);
    colorPickerState.l = Math.round(100 - (y / rect.height) * 100);
    
    document.getElementById('sat-slider').value = colorPickerState.s;
    document.getElementById('light-slider').value = colorPickerState.l;
    
    updateColorDisplay();
  };
  
  const onMouseMove = (e) => {
    if (isDragging) updateFromMouse(e);
  };
  
  const onMouseUp = () => {
    isDragging = false;
    document.onmousemove = null;
    document.onmouseup = null;
  };
  
  gradientBar.onmousedown = (e) => {
    isDragging = true;
    updateFromMouse(e);
    document.onmousemove = onMouseMove;
    document.onmouseup = onMouseUp;
  };
  
  // Store cleanup function
  window.__colorPickerCleanup = () => {
    gradientBar.onmousedown = null;
    document.onmousemove = null;
    document.onmouseup = null;
  };
}

function updateGradientBackground() {
  const gradientBar = document.getElementById('color-gradient-bar');
  if (!gradientBar) return;
  
  const h = colorPickerState.h;
  
  gradientBar.style.background = `
    linear-gradient(to top, #000, transparent),
    linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))
  `;
}

function updateColorDisplay() {
  const { h, s, l, a } = colorPickerState;
  
  const swatch = document.getElementById('color-swatch');
  const colorValue = document.getElementById('color-value');
  const hueValue = document.getElementById('hue-value');
  const satValue = document.getElementById('sat-value');
  const lightValue = document.getElementById('light-value');
  const opacityValue = document.getElementById('opacity-value');
  
  if (swatch) {
    swatch.style.background = `hsla(${h}, ${s}%, ${l}%, ${a / 100})`;
  }
  
  if (colorValue) {
    colorValue.textContent = `hsl(${h}°, ${s}%, ${l}%) • ${a}% opacity`;
  }
  
  if (hueValue) hueValue.textContent = h + '°';
  if (satValue) satValue.textContent = s + '%';
  if (lightValue) lightValue.textContent = l + '%';
  if (opacityValue) opacityValue.textContent = a + '%';
  
  if (document.getElementById('color-picker-dropdown')?.classList.contains('show')) {
    updateGradientBackground();
    const cursor = document.getElementById('color-cursor');
    if (cursor) {
      cursor.style.left = s + '%';
      cursor.style.top = (100 - l) + '%';
    }
  }
  
  const opacitySlider = document.getElementById('opacity-slider');
  if (opacitySlider) {
    opacitySlider.style.background = `linear-gradient(to right, transparent, hsl(${h}, ${s}%, ${l}%))`;
  }
}

function saveExportSettings() {
  if (!DB.exportSettings) DB.exportSettings = {};
  
  DB.exportSettings.color = { ...colorPickerState };
  
  saveDB('home', true);
  closeOv('ov-export-settings');
  document.getElementById('color-picker-dropdown')?.classList.remove('show');
  
  // Clean up color picker listeners
  if (window.__colorPickerCleanup) {
    window.__colorPickerCleanup();
    window.__colorPickerCleanup = null;
  }
  
  toast('✓ Export settings saved');
  
  if (document.getElementById('s-auth').classList.contains('active')) {
    loadAuthLogo();
  }
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

// ============================================
// CONFLICT RESOLUTION UI
// ============================================
async function showConflictDialog(conflict) {
  return new Promise((resolve) => {
    const modal = document.getElementById('ov-conflict');
    const content = document.getElementById('conflict-content');
    
    content.innerHTML = `
      <div style="margin-bottom:20px">
        <h3>Conflict Detected: ${conflict.type}</h3>
        <p>This item was modified on both devices.</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
        <div style="background:var(--cream-2);padding:16px;border-radius:12px">
          <div style="font-weight:700;margin-bottom:8px">Local Version</div>
          <pre style="font-size:11px;overflow:auto">${JSON.stringify(conflict.local, null, 2).substring(0, 200)}</pre>
        </div>
        <div style="background:var(--cream-2);padding:16px;border-radius:12px">
          <div style="font-weight:700;margin-bottom:8px">Cloud Version</div>
          <pre style="font-size:11px;overflow:auto">${JSON.stringify(conflict.cloud, null, 2).substring(0, 200)}</pre>
        </div>
      </div>
    `;
    
    const handleChoice = (choice) => {
      closeOv('ov-conflict');
      resolve(choice);
    };
    
    document.getElementById('conflict-keep-local').onclick = () => handleChoice('local');
    document.getElementById('conflict-keep-cloud').onclick = () => handleChoice('cloud');
    document.getElementById('conflict-merge').onclick = () => handleChoice('merge');
    
    openOv('ov-conflict');
  });
}

async function showMergeEditor(conflict) {
  // Simple merge - could be enhanced with diff editor
  toast('Auto-merging...');
  return 'local'; // Default to local for now
}

// ============================================
// DEMO REQUEST FUNCTION
// ============================================
function openDemoRequest() {
  openOv('ov-demo');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function openOv(id) { 
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeOv(id) { 
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
function v(id) { return document.getElementById(id).value.trim(); }
function sv(id, val) { document.getElementById(id).value = val; }

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clrInputs(ids) { ids.forEach(id => sv(id, '')); }
function shake(id) { 
  const el = document.getElementById(id); 
  if (!el) return;
  el.style.animation = 'shake .3s'; 
  setTimeout(() => el.style.animation = '', 300); 
}
function ifEnter(e, fn) { if (e.key === 'Enter') { e.preventDefault(); fn(); } }
function todayStr() { 
  const d = new Date(); 
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); 
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
// Alias for backward compatibility
const toast = showToast;

let confirmCb = null;
function confirm_(title, desc, cb) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-desc').textContent = desc;
  confirmCb = cb;
  openOv('ov-confirm');
}
function confirmOk() { if (confirmCb) confirmCb(); confirmCb = null; closeOv('ov-confirm'); }

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  // Setup color picker listeners
  const hueSlider = document.getElementById('hue-slider');
  const satSlider = document.getElementById('sat-slider');
  const lightSlider = document.getElementById('light-slider');
  const opacitySlider = document.getElementById('opacity-slider');
  
  if (hueSlider) {
    hueSlider.addEventListener('input', (e) => {
      colorPickerState.h = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  if (satSlider) {
    satSlider.addEventListener('input', (e) => {
      colorPickerState.s = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  if (lightSlider) {
    lightSlider.addEventListener('input', (e) => {
      colorPickerState.l = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  if (opacitySlider) {
    opacitySlider.addEventListener('input', (e) => {
      colorPickerState.a = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  setupDragAndDrop();
  
  // Global escape key handler
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.ov.open').forEach(el => el.classList.remove('open'));
      document.getElementById('sheet-ov')?.classList.remove('open');
      document.getElementById('color-picker-dropdown')?.classList.remove('show');
      
      // Clean up color picker listeners
      if (window.__colorPickerCleanup) {
        window.__colorPickerCleanup();
        window.__colorPickerCleanup = null;
      }
    }
  });
  
  // Handle page unload - save any pending changes
  window.addEventListener('beforeunload', () => {
    if (DB.pendingChanges.length > 0) {
      saveToLocalStorage();
    }
  });
});

// Splash screen and initial load
let splashTimeout = setTimeout(() => {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('exit');
    setTimeout(() => {
      splash.style.display = 'none';
      loadDB().then(() => {
        if (DB.user) enterApp(); else showLanding();
      });
    }, 800);
  }
}, 2800);

// Clean up on page unload
window.addEventListener('unload', () => {
  if (splashTimeout) clearTimeout(splashTimeout);
  stopAutoSync();
  if (abortController) abortController.abort();
  if (window.__colorPickerCleanup) window.__colorPickerCleanup();
});
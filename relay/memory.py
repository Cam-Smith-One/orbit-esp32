"""Explicit, deletable durable facts for the Orbit relay."""
import sqlite3

class MemoryStore:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, fact TEXT NOT NULL COLLATE NOCASE UNIQUE)')
        self.db.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))")

    def save_note(self, text):
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
            raise ValueError('Note must contain 1-4000 characters')
        with self.db:
            cursor = self.db.execute('INSERT INTO notes(text) VALUES (?)', (text.strip(),))
        return {'id': cursor.lastrowid, 'text': text.strip()}

    def notes(self):
        return [dict(row) for row in self.db.execute('SELECT * FROM notes ORDER BY id DESC LIMIT 10')]

    def delete_note(self, note_id):
        if type(note_id) is not int or note_id < 1: raise ValueError('Invalid note ID')
        with self.db:
            return self.db.execute('DELETE FROM notes WHERE id = ?', (note_id,)).rowcount == 1

    def remember(self, fact):
        if not isinstance(fact, str) or not 1 <= len(fact.strip()) <= 500:
            raise ValueError('Memory must contain 1-500 characters')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO memories(fact) VALUES (?)', (fact.strip(),))
        return dict(self.db.execute('SELECT * FROM memories WHERE fact = ?', (fact.strip(),)).fetchone())

    def recall(self, query=''):
        if not isinstance(query, str) or len(query) > 200:
            raise ValueError('Invalid memory query')
        # ponytail: literal substring search; add FTS only if a personal fact list outgrows this.
        return [dict(row) for row in self.db.execute(
            'SELECT * FROM memories WHERE instr(lower(fact),lower(?)) > 0 ORDER BY id DESC LIMIT 30', (query,))]

    def forget(self, memory_id):
        if type(memory_id) is not int or memory_id < 1:
            raise ValueError('Invalid memory ID')
        with self.db:
            return self.db.execute('DELETE FROM memories WHERE id = ?', (memory_id,)).rowcount == 1

import { one, query } from '../db.js';

const fourEyes = async () => (await one<{ value: any }>("SELECT value FROM app_settings WHERE key = 'four_eyes'"))?.value !== false;

/** For the card: versions (without the heavy snapshot), comments, the send queue. */
export async function forCard(id: string) {
  return {
    versions: await query(`SELECT v.id, v.version_no, v.submitted_at, v.decision, v.decided_at, v.decision_reason, v.tvinn_id, v.result, v.answer, v.mrn, v.tvinn_no, v.answered_at,
        (v.message IS NOT NULL) has_message, su.name submitted_by_name, v.submitted_by, de.name decided_by_name
        FROM declaration_version v LEFT JOIN users su ON su.id = v.submitted_by LEFT JOIN users de ON de.id = v.decided_by
        WHERE v.declaration_id = $1 ORDER BY v.version_no DESC`, [id]),
    comments: await query(`SELECT c.id, c.text, c.created_at, u.name user_name FROM declaration_comment c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.declaration_id = $1 ORDER BY c.created_at`, [id]),
    queue: await query(`SELECT q.id, q.status, q.attempts, q.next_try_at, q.last_error, q.adapter, q.queued_at, q.finished_at, v.version_no FROM send_queue q
        JOIN declaration_version v ON v.id = q.version_id WHERE q.declaration_id = $1 ORDER BY q.queued_at DESC LIMIT 10`, [id]),
    workflow: { fourEyes: await fourEyes() }
  };
}


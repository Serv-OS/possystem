package co.posup.rpos.paxpay.store;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

import co.posup.rpos.paxpay.model.TerminalJob;

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *  THE TERMINAL'S WRITE-AHEAD LOG — the only safety net that exists on this device.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The spec is blunt about the gap this fills: until Ryft supply the G8:Cloud spec there is NO
 * server-side recovery for a charge. Nothing can ask the processor "did this go through?". So
 * if this app is killed — battery pull, crash, Android reaping it while the STS controller is
 * in front — the ONLY record that a payment was in flight is this SQLite file.
 *
 * android.database.sqlite is in the framework: no new dependency, and it is durable across a
 * process kill in a way SharedPreferences (which batches on apply()) is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE STATE MACHINE. Each transition is written BEFORE the action it describes.
 *
 *   INTENT    tip committed server-side; the controller has NOT been launched.
 *             → deterministically SAFE. No card was touched. Resolvable as cancelled.
 *
 *   SENT      the controller HAS been launched. The outcome is UNKNOWN.
 *             → the dangerous state. Never auto-retried. Always surfaced to a human.
 *
 *   RESULT    we know the outcome but the server has not accepted it yet.
 *             → replayed FOREVER, with no staleness floor. This is RPOS's ALWAYS_REPLAY rule
 *               (OfflineQueue.js): a completed charge is a FACT and facts do not expire. A
 *               terminal that was in a drawer for three days still owes the venue this row.
 *
 *   REPORTED  the server has it. Kept briefly for audit, then pruned.
 *
 * The asymmetry between INTENT and RESULT is the whole design: an INTENT is an intention and
 * intentions go stale (rule 10 — a terminal left overnight must not fire yesterday's tender);
 * a RESULT is a fact and facts are replayed however old.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
public final class JobLog extends SQLiteOpenHelper {

    private static final String DB = "paxpay_wal.db";
    private static final int VERSION = 1;
    private static final String T = "payment_log";

    public static final String STATE_INTENT = "INTENT";
    public static final String STATE_SENT = "SENT";
    public static final String STATE_RESULT = "RESULT";
    public static final String STATE_REPORTED = "REPORTED";

    /**
     * An INTENT older than this must never auto-charge on boot (spec money rule 10). It is held
     * and surfaced instead. 2h matches STALE_ORDER_FLOOR_MS in the web app's OfflineQueue.
     */
    public static final long INTENT_STALE_MS = 2L * 60 * 60 * 1000;

    /** Reported rows are kept this long so an operator can still see yesterday's activity. */
    private static final long PRUNE_AFTER_MS = 30L * 24 * 60 * 60 * 1000;

    public JobLog(Context c) {
        super(c.getApplicationContext(), DB, null, VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("create table " + T + " ("
                + " job_id text primary key,"
                + " source text not null,"
                + " label text,"
                + " currency text not null,"
                + " tip_basis_minor integer not null,"
                + " due_minor integer not null,"
                + " tip_minor integer not null,"
                + " charge_minor integer not null,"
                + " state text not null,"
                + " approved integer,"
                + " transaction_id text,"
                + " auth_code text,"
                + " card_json text,"
                + " decline_reason text,"
                + " reported_minor integer,"
                + " report_attempts integer not null default 0,"
                + " last_error text,"
                + " created_at integer not null,"
                + " updated_at integer not null)");
        db.execSQL("create index idx_state on " + T + " (state)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldV, int newV) {
        // v1 only. When this changes, MIGRATE — never drop. A dropped table is a lost payment.
    }

    // -------------------------------------------------------------------------------------
    // Writes
    // -------------------------------------------------------------------------------------

    /**
     * Step 1 — the tip is committed and we are ABOUT to launch the controller.
     *
     * Called after terminal_commit_tip succeeds and before the controller intent goes out. If
     * the process dies right here, boot finds an INTENT and knows no card was touched.
     */
    public synchronized void writeIntent(TerminalJob job, String localId) {
        long now = System.currentTimeMillis();
        ContentValues v = new ContentValues();
        v.put("job_id", localId);
        v.put("source", job.source.name());
        v.put("label", job.displayLabel);
        v.put("currency", job.currency);
        v.put("tip_basis_minor", job.tipBasisMinor);
        v.put("due_minor", job.dueMinor);
        v.put("tip_minor", job.tipMinor());
        v.put("charge_minor", job.chargeMinor());
        v.put("state", STATE_INTENT);
        v.put("created_at", now);
        v.put("updated_at", now);
        getWritableDatabase().insertWithOnConflict(
                T, null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Step 2 — the controller has been launched. From here the outcome is unknown. */
    public synchronized void markSent(String localId) {
        ContentValues v = new ContentValues();
        v.put("state", STATE_SENT);
        v.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().update(T, v, "job_id = ?", new String[]{localId});
    }

    /**
     * Step 3 — we know what happened. Written BEFORE any attempt to tell the server, so a
     * network failure at that moment cannot lose the outcome.
     */
    public synchronized void writeResult(String localId, boolean approved, String transactionId,
                                         String authCode, String cardJson, String declineReason,
                                         long reportedMinor) {
        ContentValues v = new ContentValues();
        v.put("state", STATE_RESULT);
        v.put("approved", approved ? 1 : 0);
        v.put("transaction_id", transactionId);
        v.put("auth_code", authCode);
        v.put("card_json", cardJson);
        v.put("decline_reason", declineReason);
        v.put("reported_minor", reportedMinor);
        v.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().update(T, v, "job_id = ?", new String[]{localId});
    }

    /** Step 4 — the server has accepted it. */
    public synchronized void markReported(String localId) {
        ContentValues v = new ContentValues();
        v.put("state", STATE_REPORTED);
        v.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().update(T, v, "job_id = ?", new String[]{localId});
    }

    public synchronized void noteAttempt(String localId, String error) {
        getWritableDatabase().execSQL(
                "update " + T + " set report_attempts = report_attempts + 1,"
                        + " last_error = ?, updated_at = ? where job_id = ?",
                new Object[]{error, System.currentTimeMillis(), localId});
    }

    /**
     * Resolve a MANUAL row locally.
     *
     * There is no server job to report a manual payment to, so once its outcome is on screen the
     * row has done its job. It is still written first — a manual sale that vanishes in a crash is
     * still a sale the operator needs to know about.
     */
    public synchronized void closeLocal(String localId) {
        markReported(localId);
    }

    // -------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------

    /** One logged payment. */
    public static final class Entry {
        public String jobId;
        public String source;
        public String label;
        public String currency;
        public long tipBasisMinor;
        public long dueMinor;
        public long tipMinor;
        public long chargeMinor;
        public String state;
        public Boolean approved;
        public String transactionId;
        public String authCode;
        public String cardJson;
        public String declineReason;
        public long reportedMinor;
        public int reportAttempts;
        public String lastError;
        public long createdAt;
        public long updatedAt;

        public boolean isManual() { return TerminalJob.Source.MANUAL.name().equals(source); }
        public long ageMs() { return System.currentTimeMillis() - createdAt; }
        public boolean isStaleIntent() {
            return STATE_INTENT.equals(state) && ageMs() > INTENT_STALE_MS;
        }
    }

    /**
     * Everything the app must resolve before it may take another payment, oldest first.
     *
     * Deliberately NOT filtered by age. A SENT row from last Tuesday is exactly the row that
     * most needs a human to look at it.
     */
    public synchronized List<Entry> unfinished() {
        List<Entry> out = new ArrayList<>();
        Cursor c = null;
        try {
            c = getReadableDatabase().rawQuery(
                    "select * from " + T + " where state != ? order by created_at asc",
                    new String[]{STATE_REPORTED});
            while (c.moveToNext()) out.add(read(c));
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return out;
    }

    public synchronized Entry find(String localId) {
        Cursor c = null;
        try {
            c = getReadableDatabase().rawQuery(
                    "select * from " + T + " where job_id = ?", new String[]{localId});
            if (c.moveToNext()) return read(c);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    public synchronized int unfinishedCount() {
        Cursor c = null;
        try {
            c = getReadableDatabase().rawQuery(
                    "select count(*) from " + T + " where state != ?",
                    new String[]{STATE_REPORTED});
            if (c.moveToNext()) return c.getInt(0);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return 0;
    }

    /** Drops only rows the server has already accepted, and only once they are ancient. */
    public synchronized void prune() {
        try {
            getWritableDatabase().delete(T, "state = ? and updated_at < ?",
                    new String[]{STATE_REPORTED,
                            String.valueOf(System.currentTimeMillis() - PRUNE_AFTER_MS)});
        } catch (Exception ignored) {
        }
    }

    private static Entry read(Cursor c) {
        Entry e = new Entry();
        e.jobId = str(c, "job_id");
        e.source = str(c, "source");
        e.label = str(c, "label");
        e.currency = str(c, "currency");
        e.tipBasisMinor = lng(c, "tip_basis_minor");
        e.dueMinor = lng(c, "due_minor");
        e.tipMinor = lng(c, "tip_minor");
        e.chargeMinor = lng(c, "charge_minor");
        e.state = str(c, "state");
        int ai = c.getColumnIndex("approved");
        e.approved = (ai < 0 || c.isNull(ai)) ? null : c.getInt(ai) == 1;
        e.transactionId = str(c, "transaction_id");
        e.authCode = str(c, "auth_code");
        e.cardJson = str(c, "card_json");
        e.declineReason = str(c, "decline_reason");
        e.reportedMinor = lng(c, "reported_minor");
        e.reportAttempts = (int) lng(c, "report_attempts");
        e.lastError = str(c, "last_error");
        e.createdAt = lng(c, "created_at");
        e.updatedAt = lng(c, "updated_at");
        return e;
    }

    private static String str(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return (i < 0 || c.isNull(i)) ? null : c.getString(i);
    }

    private static long lng(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return (i < 0 || c.isNull(i)) ? 0L : c.getLong(i);
    }
}

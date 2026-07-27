package co.posup.rpos.paxpay;

import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import co.posup.rpos.paxpay.g8.G8CloudClient;
import co.posup.rpos.paxpay.g8.G8SaleRequest;
import co.posup.rpos.paxpay.g8.G8TransactionResult;
import co.posup.rpos.paxpay.g8.ServerG8CloudClient;
import co.posup.rpos.paxpay.g8.StubG8CloudClient;
import co.posup.rpos.paxpay.model.OpenTable;
import co.posup.rpos.paxpay.model.Pairing;
import co.posup.rpos.paxpay.model.StaffSession;
import co.posup.rpos.paxpay.model.TerminalJob;
import co.posup.rpos.paxpay.model.TerminalSettings;
import co.posup.rpos.paxpay.net.OpsApi;
import co.posup.rpos.paxpay.net.SupabaseClient;
import co.posup.rpos.paxpay.store.JobLog;
import co.posup.rpos.paxpay.store.Prefs;
import co.posup.rpos.paxpay.store.ScreensaverCache;
import co.posup.rpos.paxpay.ui.AmountScreen;
import co.posup.rpos.paxpay.ui.ConfirmScreen;
import co.posup.rpos.paxpay.ui.DiagnosticsScreen;
import co.posup.rpos.paxpay.ui.HomeScreen;
import co.posup.rpos.paxpay.ui.PairingScreen;
import co.posup.rpos.paxpay.ui.PinScreen;
import co.posup.rpos.paxpay.ui.PosIdleScreen;
import co.posup.rpos.paxpay.ui.ResultScreen;
import co.posup.rpos.paxpay.ui.ScreensaverScreen;
import co.posup.rpos.paxpay.ui.StatusScreen;
import co.posup.rpos.paxpay.ui.TableListScreen;
import co.posup.rpos.paxpay.ui.TipScreen;
import co.posup.rpos.paxpay.ui.Ui;
import co.posup.rpos.paxpay.ui.UnresolvedScreen;

/**
 * Serv OS PaxPay — card payments on a PAX A920 Pro via the Ryft / STS "G8" stack.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NATIVE AND NOT A WEBVIEW
 *
 * :app, :mpos and :menuboard are all thin WebViews over the RPOS SPA. That approach was TRIED
 * on this exact hardware and FAILED: the A920 Pro runs Android 10 with a system WebView on
 * Chrome 80, and the SPA bundle dies on `??=` (logical-assignment, Chrome 85+) and on ~2,292
 * flex `gap` rules (Chrome 84+). So the payment surface here is written natively and stays
 * SMALL. Do not reintroduce the SPA into this module.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * MILESTONE 2 — a three-mode terminal. This class is the router and the payment coordinator; the
 * screens are dumb views and the network lives in net/.
 *
 *   1. TABLE PAY       staff PIN → pick an open table → confirm → tip → charge. WHOLE BILL ONLY.
 *   2. MANUAL PAYMENT  the milestone-1 keypad, now behind the home screen.
 *   3. WAITING FOR POS poll terminal_jobs for a job the till addressed to this terminal.
 *
 * Before any of that: PAIRING. An unpaired terminal shows a claim code and does nothing else.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *  ★ THE ORDERING RULE — TRUE ON EVERY PATH IN THIS FILE, WITHOUT EXCEPTION ★
 *
 *      show the amount  →  tip screen  →  COMMIT THE TIP  →  only then launch the controller
 *
 *  There is exactly ONE place in this class that launches the STS controller ({@link #launchCharge})
 *  and exactly one way to reach it ({@link #onTipChosen}), which either commits the tip
 *  server-side first or — for a manual payment, where no server job exists — writes the local
 *  write-ahead log first. Both branches persist the intent before the card is touched.
 *
 *  That ordering is what makes a lost sale recoverable: if this process dies a millisecond later,
 *  the row already says exactly what was about to be charged. Charge first and record after, and
 *  a crash in the gap is money taken with no record of what for.
 *
 *  If you add a fourth mode, route it through onTipChosen(). Do not add a second launch site.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
public class MainActivity extends ComponentActivity {

    /**
     * ┌────────────────────────────────────────────────────────────────────────────────────┐
     * │  SEAM — RPOS → PaxPay (milestone 1, still supported)                                │
     * │                                                                                    │
     * │  Launch this activity with these extras and it goes straight to a manual payment    │
     * │  for that amount, skipping the home screen. Kept working so the original            │
     * │  integration point does not break; new work should use mode 3 (a job row) instead,  │
     * │  which is recoverable — an intent extra is not.                                     │
     * └────────────────────────────────────────────────────────────────────────────────────┘
     */
    public static final String EXTRA_BASE_MINOR = "co.posup.rpos.paxpay.BASE_MINOR";
    public static final String EXTRA_REFERENCE  = "co.posup.rpos.paxpay.REFERENCE";
    /** Lets the caller force tipping off for this sale (e.g. a refund, or a no-tip venue). */
    public static final String EXTRA_TIPPING_ENABLED = "co.posup.rpos.paxpay.TIPPING_ENABLED";

    /** How often an unpaired terminal re-checks whether a manager has adopted it. */
    private static final long PAIRING_POLL_MS = 6_000L;
    /** Heartbeat cadence once paired. Cheap, and it is how Back Office shows "online". */
    private static final long HEARTBEAT_MS = 60_000L;

    /**
     * How long the terminal must sit untouched ON THE HOME SCREEN before the venue's idle image
     * covers it. v2.0-rc9: the owner wants the venue's screensaver/branding to appear almost
     * immediately when the terminal is set down, so this is 5s (was 60s). It fires ONLY on the
     * idle Home / PosIdle surface, any touch wakes it, and an incoming payment overrides it — so a
     * short delay costs nothing in service: the screensaver is never shown during a payment.
     *
     * The timer is armed in exactly one place (the end of {@link #showHome}) and cancelled in
     * exactly one place ({@link #setScreen}). See the safety note on {@link #armScreensaver}.
     */
    private static final long SCREENSAVER_IDLE_MS = 5_000L;
    /**
     * v2.0-rc11 — DEEP SLEEP. How long the screensaver image may sit on the panel before the
     * terminal genuinely sleeps: black overlay + zero window brightness + FLAG_KEEP_SCREEN_ON
     * CLEARED so the OS display timeout can power the panel down.
     *
     * WHY THIS EXISTS: onCreate used to set FLAG_KEEP_SCREEN_ON unconditionally and never clear
     * it, so these terminals ran their backlight 24/7 and the screensaver merely painted a
     * STATIC image over a permanently-lit panel — which is precisely how an A920 got burn-in
     * ("screen bleed") and was written off. A payment terminal must not sleep mid-transaction;
     * it must absolutely sleep when nothing has happened for minutes.
     */
    private static final long SCREEN_SLEEP_AFTER_MS = 3L * 60 * 1000;

    /**
     * How long an IDLE-FIRST terminal waits before trying to recover a lost session on its own.
     * Long enough that a persistent failure cannot spin the CPU or the network; short enough that
     * an unattended terminal is back in service well inside a service period.
     */
    private static final long IDLE_RECOVERY_MS = 15_000L;

    private final Diagnostics diag = new Diagnostics();
    private final Handler ui = new Handler(Looper.getMainLooper());

    private Prefs prefs;
    private JobLog jobLog;
    private SupabaseClient sb;
    private OpsApi api;
    private RecoveryRunner recovery;
    private JobPoller poller;

    private G8CloudClient g8;
    private PaymentFlow flow;
    private UpdateChecker updateChecker;

    private FrameLayout content;
    private TextView diagFooter;
    private ActivityResultLauncher<Intent> controllerLauncher;

    // ---- per-session state -----------------------------------------------------------------
    /** Venue tip rules for the MANUAL path only. Job-backed payments use the job's frozen config. */
    private TipConfig manualTipConfig;
    private StaffSession staff;
    private PinScreen pinScreen;
    private TableListScreen tableScreen;
    /** v1.6-m2 — refreshes the open-tables list while it is on screen, so a table paid or cleared
     *  on another device (or on the till) drops off this terminal within ~12s instead of lingering
     *  until the operator leaves and re-opens the list. terminal_open_tables reads active_sessions
     *  live, so a re-poll is all that is needed — the row is already gone server-side. */
    private final android.os.Handler tablesPoll =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private static final long TABLES_POLL_MS = 12_000;
    private final Runnable tablesPollTick = new Runnable() {
        @Override public void run() {
            // Only while the list is actually the visible screen. getParent() goes null the moment
            // setScreen() swaps it out, so this self-stops on navigate-away with no extra bookkeeping.
            if (tableScreen != null && tableScreen.getParent() != null) {
                diag.event("open-tables auto-refresh");
                loadTables();
                tablesPoll.postDelayed(this, TABLES_POLL_MS);
            }
        }
    };
    /** v5.5.841 — the idle-first resting screen. Non-null only in POS-dispatch-only mode. */
    private PosIdleScreen posIdleScreen;
    private StatusScreen statusScreen;

    /** The payment in progress, or null. */
    private TerminalJob activeJob;
    /** Write-ahead-log key for {@link #activeJob}. Equals the job id, or a local id for manual. */
    private String activeLocalId;
    /** Reference sent to the processor. Job id where there is one. */
    private String activeReference;

    private long launchedWithBaseMinor;
    private String launchedWithReference;
    private boolean launchedWithTipping = true;
    private boolean handledLaunchExtras = false;

    private Runnable pairingPoll;
    private Runnable heartbeatTick;

    // ---- v5.5.838 Back Office settings + screensaver ----------------------------------------
    /** What Back Office says this terminal may offer. NEVER null — allowAll() until told otherwise. */
    private TerminalSettings settings = TerminalSettings.allowAll();
    private ScreensaverCache ssCache;
    private Runnable idleTick;
    private boolean screensaverShowing;
    private Runnable sleepTick;          // screensaver → deep sleep countdown
    private boolean deepAsleep;          // panel is dark; any touch or inbound job wakes it
    private View sleepOverlay;           // plain black view over the screensaver image

    // =========================================================================================
    // Lifecycle
    // =========================================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A payment terminal must not dim or sleep mid-transaction — but it MUST sleep when it
        // has been idle for minutes (v2.0-rc11). This flag is now cleared in enterDeepSleep()
        // and restored in wakeScreen(); see SCREEN_SLEEP_AFTER_MS for the burn-in history.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        prefs = new Prefs(this);
        jobLog = new JobLog(this);
        sb = new SupabaseClient(this, prefs);
        api = new OpsApi(sb);
        recovery = new RecoveryRunner(sb, api, jobLog, diag);
        ssCache = new ScreensaverCache(this, prefs);

        // v5.5.838: render the home screen from the LAST KNOWN settings so a terminal whose
        // modes were narrowed does not flash a button it is no longer allowed to offer. The
        // server row replaces this on the first fetch; absent cache = all modes on.
        settings = readCachedSettings();

        // ── the ONE construction site for the G8 client ─────────────────────────────────────
        // The real implementation (v2.0-rc1): every charge is proxied through our own
        // terminal-job-charge edge function — the device never holds a Ryft key and never
        // supplies an amount. The stub stays, fenced behind the flag, so a SIMULATED bench
        // build still exercises the whole flow with no card and no processor.
        g8 = BuildVersion.SIMULATED ? new StubG8CloudClient() : new ServerG8CloudClient(sb);

        // Manual payments have no job row, so they have no frozen tip config. These local
        // defaults are the only place TipConfig.defaults() is still used — a job-backed payment
        // reads TipConfig.fromJobJson, which FAILS CLOSED rather than inventing bands.
        manualTipConfig = TipConfig.defaults();

        Intent launchedWith = getIntent();
        launchedWithBaseMinor = launchedWith == null ? 0L
                : launchedWith.getLongExtra(EXTRA_BASE_MINOR, 0L);
        launchedWithReference = launchedWith == null ? null
                : launchedWith.getStringExtra(EXTRA_REFERENCE);
        launchedWithTipping = launchedWith == null
                || launchedWith.getBooleanExtra(EXTRA_TIPPING_ENABLED, true);
        if (!launchedWithTipping) manualTipConfig = TipConfig.disabled();

        buildChrome();

        // registerForActivityResult MUST be called before the activity is STARTED, hence here.
        controllerLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    // The STS controller has finished and handed control back to us.
                    if (flow != null) flow.onControllerResult(result.getResultCode());
                });

        diag.setListener(() -> runOnUiThread(this::refreshFooter));
        diag.g8ClientDescription = g8.describe();
        diag.serial = prefs.serial(this);
        diag.authUid = prefs.authUid();
        diag.deviceId = prefs.deviceId();
        diag.pairingStatus = prefs.status();
        diag.venueLabel = prefs.label();
        diag.unresolvedPayments = jobLog.unfinishedCount();
        diag.event("app started, build " + BuildVersion.VERSION);

        // Probe for the controller at boot so the diagnostics line is meaningful BEFORE anyone
        // tries to take a payment — an operator should learn the payment app is missing while
        // setting the terminal up, not with a customer standing there.
        probeControllerAtBoot();

        if (!Config.isConfigured()) {
            // No point going further: every screen after this needs the backend.
            showFatal("Not configured", Config.explainMisconfiguration());
            return;
        }

        boot();

        // Self-update. v2.0-rc10: cold start FORCES a check — the 3h throttle is persisted in
        // prefs, so "force-stop + reopen to get the update" silently did nothing (owner-reported).
        // A cold start is rare + deliberate; the throttle still governs onResume re-checks.
        updateChecker = new UpdateChecker(this);
        content.postDelayed(() -> updateChecker.check(true), 8000);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (updateChecker != null) updateChecker.check(false);
        ensureAmbientPolling();                                   // may have been torn down
        if (poller != null && poller.isRunning()) poller.nudge();
    }

    /**
     * NOTE: the DEVICE_CONNECTED receiver is deliberately NOT unregistered in onPause/onStop.
     * Launching the STS controller backgrounds this activity, and the broadcast arrives while
     * we are backgrounded — tearing the receiver down on pause would drop the one signal the
     * whole flow depends on. It is released in onDestroy instead. See PaymentFlow.dispose().
     */
    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (flow != null) flow.dispose();
        if (updateChecker != null) updateChecker.destroy();
        if (poller != null) poller.stop();
        if (pinScreen != null) pinScreen.wipe();   // a PIN never outlives the screen
        ui.removeCallbacksAndMessages(null);
        if (sb != null) sb.shutdown();
    }

    // =========================================================================================
    // Boot: pairing → recovery → home
    // =========================================================================================

    private void boot() {
        showStatus("Starting up…", prefs.isPaired() ? "Checking for unfinished payments" : "");
        refreshPairing(true);
    }

    /**
     * Register (or re-find) this terminal against its SERIAL.
     *
     * Idempotent server-side, so it doubles as the "has a manager adopted me yet?" poll and as
     * the recovery path when a session has been lost — see the note in SupabaseClient about why
     * this is the ONE call allowed to create a new anonymous identity.
     */
    private void refreshPairing(final boolean advanceOnSuccess) {
        final String serial = prefs.serial(this);
        sb.async(() -> api.registerDevice(serial), new SupabaseClient.Result<Pairing>() {
            @Override public void onSuccess(Pairing p) {
                prefs.savePairing(p.deviceId, p.claimCode, p.status, p.locationId, p.label);
                diag.deviceId = p.deviceId;
                diag.claimCode = p.claimCode;
                diag.pairingStatus = p.status;
                diag.venueLabel = p.label;
                diag.authUid = prefs.authUid();
                diag.event("registered: " + p.status
                        + (p.label == null ? "" : " (" + p.label + ")"));

                if (p.isRetired()) {
                    stopPairingPoll();
                    showFatal("Terminal retired",
                            "This terminal has been retired in Back Office and can no longer "
                                    + "take payments.\n\nAsk a manager to re-add it.");
                    return;
                }

                if (p.isPaired()) {
                    stopPairingPoll();
                    startHeartbeat();
                    refreshSettings();          // v5.5.838: modes + idle screen
                    // The terminal can receive from the till from this moment on, whatever is
                    // drawn. This is the FIRST of the ambient poller's lifecycle call sites.
                    ensureAmbientPolling();
                    if (advanceOnSuccess) runRecoveryThenContinue();
                } else {
                    showPairing(null, false);
                    startPairingPoll();
                }
            }

            @Override public void onError(String message) {
                diag.lastRpcError = message;
                diag.event("register failed: " + message);

                // A terminal that is ALREADY paired and simply cannot reach the server must not
                // be dumped back to a pairing screen — it is a network problem, not a pairing
                // problem, and the difference matters to whoever is holding it. Carry on into
                // recovery; the individual payment calls will report their own failures.
                if (prefs.isPaired()) {
                    startHeartbeat();
                    if (advanceOnSuccess) runRecoveryThenContinue();
                    return;
                }
                showPairing(message, false);
                startPairingPoll();
            }
        });
    }

    private void startPairingPoll() {
        if (pairingPoll != null) return;
        pairingPoll = new Runnable() {
            @Override public void run() {
                refreshPairing(true);
                ui.postDelayed(this, PAIRING_POLL_MS);
            }
        };
        ui.postDelayed(pairingPoll, PAIRING_POLL_MS);
    }

    private void stopPairingPoll() {
        if (pairingPoll != null) {
            ui.removeCallbacks(pairingPoll);
            pairingPoll = null;
        }
    }

    private void startHeartbeat() {
        if (heartbeatTick != null) return;
        heartbeatTick = new Runnable() {
            @Override public void run() {
                final String id = prefs.deviceId();
                if (id != null) {
                    // Fire and forget. A failed heartbeat must never block or interrupt a payment.
                    sb.async(() -> { api.heartbeat(id); return null; }, null);
                    // v5.5.838: piggyback the settings refresh on the heartbeat, so a change made
                    // in Back Office reaches the terminal within a minute without a second timer.
                    refreshSettings();
                    // v5.5.841: and the ambient poller's safety net. Whatever stopped it — a lost
                    // session, a claim, an unhandled path — it is listening again within a minute.
                    ensureAmbientPolling();
                }
                ui.postDelayed(this, HEARTBEAT_MS);
            }
        };
        ui.post(heartbeatTick);
    }

    /**
     * Resolve anything the write-ahead log is still holding, THEN let the terminal trade.
     *
     * The order is the point: a terminal with an unresolved payment must not offer a fourth one
     * until a human has looked at the third. See RecoveryRunner.
     */
    private void runRecoveryThenContinue() {
        showStatus("Checking for unfinished payments…", "");
        recovery.run(needingHuman -> {
            diag.unresolvedPayments = jobLog.unfinishedCount();
            if (needingHuman != null && !needingHuman.isEmpty()) {
                showUnresolved(needingHuman);
                return;
            }
            // The milestone-1 launch seam: an amount passed in the intent goes straight to a
            // manual payment, once, and only after recovery has cleared.
            if (!handledLaunchExtras && launchedWithBaseMinor > 0) {
                handledLaunchExtras = true;
                beginManual(launchedWithBaseMinor);
                return;
            }
            showHome();
        });
    }

    // =========================================================================================
    // Home
    // =========================================================================================

    /**
     * IDLE-FIRST (v5.5.841): is there NOTHING on this terminal for a human to start?
     *
     * Since POS dispatch stopped being a mode somebody enters, the home screen carries exactly
     * two buttons — Table Pay and Manual payment. Switch both off and the screen has nothing on
     * it worth showing: every payment this terminal will take is pushed from the till, and there
     * is nobody standing at it to tap anything. So it skips the home screen and rests on the
     * venue's screensaver instead, still receiving payments the whole time.
     *
     * This now falls out of the model rather than being a special case: pos_dispatch is what
     * makes the terminal USABLE in that configuration, but it is not what puts a button on the
     * screen, because it never had one.
     */
    private boolean isIdleFirst() {
        return settings.posDispatch && !settings.tablePay && !settings.manual;
    }

    private void showHome() {
        staff = null;
        diag.staffName = null;
        diag.currentJobId = null;
        activeJob = null;
        activeLocalId = null;

        if (isIdleFirst()) {
            showPosIdle();
            return;
        }

        diag.event("home: table=" + settings.tablePay + " manual=" + settings.manual
                + " pos=" + settings.posDispatch + " (pos is ambient — no button)");
        setScreen(new HomeScreen(this, prefs.label(), jobLog.unfinishedCount(), settings,
                new HomeScreen.Listener() {
                    @Override public void onTablePay() { showPin(null); }
                    @Override public void onManualPayment() { showAmountScreen(); }
                    @Override public void onReviewUnresolved() {
                        showUnresolved(jobLog.unfinished());
                    }
                }));

        // ARMING SITE 1 OF 3. See armScreensaver().
        armScreensaver();
    }

    /**
     * The idle-first resting state: the venue's branding, with the terminal receiving underneath.
     *
     * Reached ONLY through {@link #showHome}, which is what every "we are done, go back to a safe
     * idle state" path in this class already calls — boot, cancel, and finishPayment. So the
     * post-payment return lands here without a single extra call site, and the terminal goes back
     * to the screensaver rather than to a button.
     *
     * NOTE it does NOT start the poller. Polling is ambient and screen-independent — see
     * {@link #ensureAmbientPolling}. This method only decides what is drawn.
     */
    private void showPosIdle() {
        if (prefs.deviceId() == null) {
            showError("Not paired", "This terminal is not paired to a venue yet.", this::boot);
            return;
        }
        // An unresolved payment outranks idling, exactly as it outranks the home screen.
        if (jobLog.unfinishedCount() > 0) {
            diag.event("idle-first: unresolved payments block idling");
            showUnresolved(jobLog.unfinished());
            return;
        }

        diag.event("idle-first: nothing for a human to start — resting, still receiving");
        PosIdleScreen screen = new PosIdleScreen(this, prefs.label());
        setScreen(screen);              // disarms any armed screensaver and clears posIdleScreen
        posIdleScreen = screen;         // AFTER setScreen, which nulls the field

        // ARMING SITE 2 OF 3, and the only one added by idle-first. Delay 0: there is nobody to
        // interrupt on this terminal, so the branding goes up immediately rather than after the
        // 60-second grace period the staff-facing home screen needs. The tick's guard is the same
        // single predicate the claim uses — see armScreensaver().
        armScreensaver(0L);
    }

    // =========================================================================================
    // ★ THE ONE DEFINITION OF "IDLE" ★  (v5.5.841)
    // =========================================================================================

    /**
     * Why this terminal may NOT take a payment pushed from the till right now — or null if it may.
     *
     * ─────────────────────────────────────────────────────────────────────────────────────────
     * THIS IS THE ONLY PLACE "IDLE" IS DEFINED, AND IT HAS EXACTLY TWO CALLERS:
     *
     *   1. {@link JobPoller.Gate} — whether an arriving job may be CLAIMED
     *   2. the {@link #armScreensaver} tick — whether the screensaver may be SHOWN
     *
     * They have to agree. Two subtly different notions of idle is precisely how a screensaver
     * ends up over a live tip prompt, and how an arriving payment ends up tearing the screen away
     * from a customer who is part-way through authorising a different one. One predicate, two
     * callers, no ad-hoc surface tests anywhere else.
     *
     * A string rather than a boolean because the REASON is the valuable part: "a payment is
     * waiting but the terminal is on the staff PIN screen" is a sentence somebody can act on,
     * where a silent no-op reads as "the payment never arrived". {@link #canAcceptPosJob} is the
     * boolean view for sites that do not need the reason.
     * ─────────────────────────────────────────────────────────────────────────────────────────
     *
     * The screensaver needs no special case: it is an OVERLAY added at child index > 0, so the
     * idle surface underneath is still child 0 and a screensaver'd terminal reads as idle — which
     * it is. That is the whole point of it being an overlay rather than a screen.
     */
    private String posJobBusyReason() {
        if (activeJob != null)   return "a payment is already in progress";
        if (staff != null)       return "a member of staff is signed in for Table Pay";
        if (jobLog.unfinishedCount() > 0) return "an unresolved payment is waiting to be checked";
        if (content == null || content.getChildCount() == 0) return "the terminal is still starting up";
        View top = content.getChildAt(0);
        if (top instanceof HomeScreen || top instanceof PosIdleScreen) return null;   // IDLE
        return "the terminal is on " + describeScreen(top);
    }

    /** Boolean view of {@link #posJobBusyReason}. */
    private boolean canAcceptPosJob() {
        return posJobBusyReason() == null;
    }

    /** Human-readable screen name, for the diagnostics line only. */
    private static String describeScreen(View v) {
        if (v == null)                        return "an unknown screen";
        if (v instanceof PinScreen)           return "the staff PIN screen";
        if (v instanceof TableListScreen)     return "the table list";
        if (v instanceof AmountScreen)        return "the manual amount keypad";
        if (v instanceof ConfirmScreen)       return "the confirm-bill screen";
        if (v instanceof TipScreen)           return "the customer tip screen";
        if (v instanceof StatusScreen)        return "a payment in progress";
        if (v instanceof ResultScreen)        return "a payment result";
        if (v instanceof UnresolvedScreen)    return "the unresolved-payments screen";
        if (v instanceof DiagnosticsScreen)   return "the diagnostics screen";
        if (v instanceof PairingScreen)       return "the pairing screen";
        if (v instanceof ScrollView)          return "an error screen";
        return v.getClass().getSimpleName();
    }

    // =========================================================================================
    // Ambient POS dispatch (v5.5.841) — a capability, not a screen
    // =========================================================================================

    /**
     * Poll for payments pushed from the till, continuously, for as long as this terminal is
     * allowed to receive them.
     *
     * ─────────────────────────────────────────────────────────────────────────────────────────
     * DELIBERATELY NOT TIED TO A SCREEN. A paired card reader on a counter does not have a "now
     * start listening" state, and the version of this that did — a "Waiting for POS" button —
     * meant a payment dispatched from the till landed on a terminal that was not polling because
     * nobody had tapped anything. It simply never appeared, with no error anywhere.
     *
     * So this is called from LIFECYCLE points, never from a show*() method:
     *   * pairing succeeded              (the terminal became able to receive at all)
     *   * the 60-second heartbeat        (the safety net — restarts it whatever happened)
     *   * a settings fetch landed        (pos_dispatch may have just been switched on or off)
     *   * a payment finished             (the poller stops itself on claim; restart immediately
     *                                     rather than waiting up to a minute for the heartbeat)
     *   * onResume
     * Idempotent, so calling it from all of them is free.
     * ─────────────────────────────────────────────────────────────────────────────────────────
     *
     * SAFETY: this starts LOOKING, not claiming. Claiming is gated on {@link #canAcceptPosJob}.
     */
    private void ensureAmbientPolling() {
        if (!settings.posDispatch) {
            if (poller != null) {
                diag.event("ambient polling OFF — pos_dispatch disabled in Back Office");
                stopPolling();
            }
            return;
        }
        final String deviceId = prefs.deviceId();
        if (deviceId == null) return;                       // not paired yet; pairing will call us
        if (poller != null && poller.isRunning()) return;    // already listening

        diag.event("ambient polling ON (terminal " + deviceId + ")");
        poller = new JobPoller(sb, api, diag, deviceId,
                this::posJobBusyReason,                      // ★ the single idle predicate ★
                new JobPoller.Listener() {
                    @Override public void onJobClaimed(TerminalJob job) { beginJob(job); }
                    @Override public void onIdle(String detail) {
                        // Only the idle screen has somewhere to put this. The home screen
                        // deliberately shows no poll status: it is staff-facing furniture, and a
                        // background poll is not their business.
                        if (posIdleScreen != null) posIdleScreen.setStatus(detail);
                    }
                    @Override public void onProblem(String message) {
                        // An AMBIENT poller must never take the screen. It runs behind a home
                        // screen a waiter is reading and behind a screensaver a customer is
                        // looking at; throwing up an error over either — repeatedly, every tick
                        // — would be worse than the problem. It goes to diagnostics and to the
                        // idle status line, and the terminal keeps trying.
                        diag.lastRpcError = message;
                        diag.event("ambient poll problem: " + message);
                        if (posIdleScreen != null) posIdleScreen.setStatus(shortError(message));

                        // JobPoller stops ITSELF on a lost session, which would otherwise mean a
                        // terminal that silently never receives another payment. Re-run pairing
                        // (the documented recovery path) after a pause long enough that a
                        // persistent failure cannot spin.
                        if (poller != null && !poller.isRunning()) {
                            diag.event("poller stopped — re-pairing in " + IDLE_RECOVERY_MS + "ms");
                            ui.postDelayed(() -> {
                                if (canAcceptPosJob()) refreshPairing(true);
                            }, IDLE_RECOVERY_MS);
                        }
                    }
                });
        poller.start();
    }

    // =========================================================================================
    // Back Office settings (v5.5.838)
    // =========================================================================================

    private TerminalSettings readCachedSettings() {
        try {
            String json = prefs.settingsJson();
            if (json == null) return TerminalSettings.allowAll();
            return TerminalSettings.fromCache(new JSONObject(json));
        } catch (Throwable t) {
            return TerminalSettings.allowAll();
        }
    }

    /**
     * Re-read this terminal's own row: which modes it may offer, and its idle image.
     *
     * FAILURE IS A NO-OP, DELIBERATELY. If the row cannot be read — offline, a database without
     * migration 20260723, an RLS change — we keep whatever we already had rather than falling
     * back to any default. A settings fetch is not allowed to take a working terminal off the
     * floor, and it is certainly not allowed to do so silently.
     */
    private void refreshSettings() {
        final String id = prefs.deviceId();
        if (id == null) return;
        sb.async(() -> api.fetchSettings(id), new SupabaseClient.Result<JSONObject>() {
            @Override public void onSuccess(JSONObject row) {
                // v5.5.841: log the RAW result every time. The success path used to be
                // silent unless the modes happened to change, so "settings are not
                // taking effect" was indistinguishable from "settings were never
                // fetched" — which cost hours. Never make a sync path invisible.
                diag.event("settings fetch -> " + (row == null ? "NULL (no row readable for id " + id + ")" : row.toString()));
                if (row == null) return;
                TerminalSettings next = TerminalSettings.from(row);
                diag.event("parsed modes: table=" + next.tablePay + " manual=" + next.manual
                        + " pos=" + next.posDispatch + " idle=" + next.idleEnabled);
                boolean modesChanged = next.tablePay != settings.tablePay
                        || next.manual != settings.manual
                        || next.posDispatch != settings.posDispatch;
                boolean idleChanged = next.idleEnabled != settings.idleEnabled
                        || !sameString(next.idleImageUrl, settings.idleImageUrl);
                boolean wasIdleFirst = isIdleFirst();
                settings = next;
                prefs.saveSettingsJson(next.toJson().toString());

                // Pull the idle image down in the background so it is on disk BEFORE the terminal
                // first goes idle — and so it survives the network dropping later.
                if (next.idleEnabled && next.idleImageUrl != null
                        && !ssCache.isCached(next.idleImageUrl)) {
                    final String url = next.idleImageUrl;
                    // v5.5.841: repaint WHEN THE DOWNLOAD LANDS. armScreensaver() refuses to arm
                    // against an image that is not on disk, so on a cold start the first fetch
                    // always loses that race — and with no callback here the terminal sat on a
                    // bare idle screen until the next thing happened to repaint it. This goes
                    // back through showHome(), so it adds no new arming site.
                    sb.async(() -> ssCache.ensure(url), new SupabaseClient.Result<Boolean>() {
                        @Override public void onSuccess(Boolean ok) {
                            diag.event("screensaver image download -> " + ok);
                            if (Boolean.TRUE.equals(ok) && canRepaintIdleSurface()) showHome();
                        }
                        @Override public void onError(String message) {
                            diag.event("screensaver image download failed: " + message);
                        }
                    });
                }

                // pos_dispatch may have just been switched on or off. Ambient polling follows the
                // capability, not a screen, so this is one of its authoritative call sites.
                ensureAmbientPolling();

                // ── REPAINT DECISION ────────────────────────────────────────────────────────
                // canRepaintIdleSurface() is false for every screen that is not an idle surface,
                // and false while a screensaver is up — so a payment can never be yanked away.
                //
                // v5.5.838/841: on the BUTTON home screen the repaint is unconditional, because
                // rebuilding two buttons is free and the alternative is an ordering bug —
                // showHome() runs at startup from the Prefs cache, the fetch lands afterwards,
                // and a cache that happened to match meant nothing ever repainted, so a terminal
                // could sit offering a button Back Office had switched off.
                //
                // v5.5.841: on the IDLE-FIRST surface a repaint is NOT free — it rebuilds the
                // surface under the screensaver — and this runs on every 60-second heartbeat, so
                // an unconditional repaint there would flicker the branding once a minute.
                // So: repaint only when something that changes what is on screen changed.
                if (canRepaintIdleSurface()) {
                    boolean wrongSurface = isIdleFirst() != isShowingPosIdle();
                    boolean repaint = !isIdleFirst() || wrongSurface || modesChanged || idleChanged;
                    if (repaint) {
                        diag.event("repainting idle surface (idleFirst " + wasIdleFirst + "->"
                                + isIdleFirst() + " wrongSurface=" + wrongSurface
                                + " modes=" + modesChanged + " idle=" + idleChanged + ")");
                        showHome();
                    }
                }
            }
            @Override public void onError(String message) {
                // Deliberately quiet: this is decoration, and the terminal keeps its last known
                // settings. It lands in diagnostics for whoever goes looking.
                diag.event("settings fetch failed: " + message);
            }
        });
    }

    // =========================================================================================
    // Screensaver (v5.5.838)
    // =========================================================================================

    /**
     * May an idle surface be REPAINTED right now?
     *
     * Not a second definition of idle — it is {@link #canAcceptPosJob} plus one extra condition
     * that belongs to repainting alone: never repaint out from under a screensaver, because
     * rebuilding the surface underneath would tear the image off the screen for no reason.
     * Claiming has no such restriction (a payment SHOULD replace the screensaver), which is
     * exactly why this is a separate, strictly narrower question rather than a rival predicate.
     */
    private boolean canRepaintIdleSurface() {
        return canAcceptPosJob() && !screensaverShowing;
    }

    /** Specifically the idle-first surface (not the button home screen). */
    private boolean isShowingPosIdle() {
        if (content == null || content.getChildCount() == 0) return false;
        return content.getChildAt(0) instanceof PosIdleScreen;
    }

    /**
     * ★ THE SCREENSAVER SAFETY RULE ★
     *
     * A screensaver appearing over a tip prompt, a card read, or a "do not remove your card"
     * message is not a cosmetic bug — it is a customer being asked to authorise something they
     * can no longer see. So arming is confined to a countable set of sites, and there is exactly
     * ONE disarming site ({@link #setScreen}, which every other screen in this class goes
     * through). Leaving an idle surface therefore cancels the timer by construction, not by
     * anybody remembering to.
     *
     * ARMING SITES — ALL OF THEM, AND KEEP IT THAT WAY:
     *   1. the end of {@link #showHome}      — the staff-facing button screen, 60s delay
     *   2. the end of {@link #showPosIdle}   — idle-first (v5.5.841), 0s delay
     *   3. {@link #dismissScreensaver}       — re-arm after a tap woke the terminal
     * Sites 1 and 2 are mutually exclusive: showHome() routes to exactly one of them per the
     * terminal's modes. Site 3 can only fire while a screensaver was already legitimately up.
     * DO NOT ADD A FOURTH. If a new mode needs idling, route it through showHome().
     *
     * On top of that structural guarantee the tick re-checks, at fire time, that:
     *   * no job is in flight        (activeJob == null)
     *   * nobody is logged in        (staff == null — a PIN'd-in session means Table Pay is live)
     *   * an idle surface is still what is showing
     *   * nothing is unresolved      (an unresolved payment must stay in front of a human)
     *
     * Belt and braces on purpose: the structural rule is what makes it correct, and the runtime
     * checks are what stop a future fourth mode from quietly breaking it. NOTE that the checks
     * run at FIRE time, not at arm time — which is what makes the 0ms idle-first arm as safe as
     * the 60s one, because a job claimed in the meantime still cancels it.
     */
    private void armScreensaver() {
        armScreensaver(SCREENSAVER_IDLE_MS);
    }

    /**
     * @param delayMs how long the terminal must sit untouched first. 0 = immediately, used ONLY
     *                by idle-first, where there is no member of staff mid-read to interrupt.
     */
    private void armScreensaver(long delayMs) {
        disarmScreensaver();
        // v2.0-rc11 — NO IMAGE STILL MEANS SLEEP. Every early return below used to leave the
        // terminal awake forever: a venue that never uploaded idle artwork (or whose download
        // hadn't landed) kept FLAG_KEEP_SCREEN_ON lit 24/7 on whatever was last drawn. That is
        // the burn-in path that cost an A920. The screensaver IMAGE is optional; sleeping is not.
        if (!settings.idleEnabled || settings.idleImageUrl == null) {
            diag.event("screensaver not armed (" + (settings.idleEnabled
                    ? "no image url configured" : "disabled in Back Office") + ") — sleeping anyway");
            armDeepSleep();
            return;
        }
        if (!ssCache.isCached(settings.idleImageUrl)) {
            // Not an error: the download is in flight and refreshSettings re-arms when it lands.
            diag.event("screensaver not armed: image not cached yet — sleeping anyway");
            armDeepSleep();
            return;
        }
        idleTick = () -> {
            idleTick = null;
            // ★ THE SAME PREDICATE THE CLAIM USES ★ — see posJobBusyReason(). It used to be four
            // hand-written checks here; they were correct, but a second hand-written copy of
            // "idle" is exactly how the two drift apart and a screensaver lands on a tip prompt.
            String busy = posJobBusyReason();
            if (busy != null) {
                diag.event("screensaver suppressed — " + busy);
                return;
            }
            if (screensaverShowing) return;   // already up
            showScreensaver();
        };
        diag.event("screensaver armed in " + delayMs + "ms");
        ui.postDelayed(idleTick, delayMs);
    }

    private void disarmScreensaver() {
        if (idleTick != null) {
            ui.removeCallbacks(idleTick);
            idleTick = null;
        }
        disarmDeepSleep();
    }

    // =========================================================================================
    // Deep sleep (v2.0-rc11) — the panel actually goes dark, and comes back on a job
    // =========================================================================================

    /** Countdown from "screensaver visible" to "panel dark". Re-armed on every wake. */
    private void armDeepSleep() {
        disarmDeepSleep();
        sleepTick = () -> { sleepTick = null; enterDeepSleep(); };
        ui.postDelayed(sleepTick, SCREEN_SLEEP_AFTER_MS);
    }

    private void disarmDeepSleep() {
        if (sleepTick != null) {
            ui.removeCallbacks(sleepTick);
            sleepTick = null;
        }
    }

    /**
     * Go dark. Three independent measures, because no single one is guaranteed on a locked-down
     * PAX build: (1) a BLACK overlay so no static artwork is being burned into the panel even if
     * the backlight stays on, (2) window brightness to zero, (3) FLAG_KEEP_SCREEN_ON cleared so
     * the OS display timeout is finally allowed to run.
     *
     * SAFETY: reuses the SAME predicate as the screensaver itself (posJobBusyReason) at FIRE
     * time, so a payment claimed during the countdown cancels the sleep rather than darkening a
     * live card prompt.
     */
    private void enterDeepSleep() {
        if (deepAsleep) return;
        String busy = posJobBusyReason();
        if (busy != null) { diag.event("deep sleep suppressed — " + busy); return; }
        // NOTE: deliberately does NOT require screensaverShowing — a terminal with no idle
        // artwork must still go dark. posJobBusyReason() already guarantees an idle surface is
        // what is on screen, which is the condition that actually matters for safety.

        deepAsleep = true;
        sleepOverlay = new View(this);
        sleepOverlay.setBackgroundColor(Color.BLACK);
        // Consume touches so the tap that WAKES the terminal cannot fall through to whatever is
        // underneath; dismissScreensaver() then does the reveal.
        sleepOverlay.setOnClickListener(v -> dismissScreensaver());
        content.addView(sleepOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = 0f;                 // darkest this window may ask for
        getWindow().setAttributes(lp);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        diag.event("deep sleep — panel dark, keep-screen-on released");
    }

    /**
     * Bring the panel back. Called by touch, by any screen transition, and — the one that
     * matters for "wake up when a till sends a payment" — by beginJob().
     *
     * The JobPoller keeps running while the screen is off (it is only stopped in onDestroy), so
     * a job still lands here; this method is what makes it VISIBLE. Uses a wake lock with
     * ACQUIRE_CAUSES_WAKEUP because window flags alone do not turn a screen back on for an
     * activity that is already resumed.
     */
    private void wakeScreen(String reason) {
        disarmDeepSleep();
        if (!deepAsleep) return;
        deepAsleep = false;
        diag.event("wake — " + reason);

        if (sleepOverlay != null) {
            content.removeView(sleepOverlay);
            sleepOverlay = null;
        }
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;   // back to system
        getWindow().setAttributes(lp);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (Build.VERSION.SDK_INT >= 27) {
            setTurnScreenOn(true);
            setShowWhenLocked(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        "paxpay:wake");
                wl.acquire(3_000L);               // auto-released; FLAG_KEEP_SCREEN_ON holds it after
            }
        } catch (Exception e) {
            diag.event("wake lock failed: " + e.getMessage());   // flags above still did their part
        }
    }

    /** Any physical touch anywhere keeps the terminal awake and restarts both countdowns. */
    @Override
    public void onUserInteraction() {
        super.onUserInteraction();
        if (deepAsleep) wakeScreen("user interaction");
    }

    private void showScreensaver() {
        android.graphics.Bitmap bmp = ssCache.bitmap(settings.idleImageUrl);
        if (bmp == null) {
            diag.event("screensaver NOT shown: image failed to decode");
            return;                              // decode failed: stay on the idle surface
        }
        diag.event("screensaver shown");
        screensaverShowing = true;
        armDeepSleep();                    // v2.0-rc11: the image must not sit here for hours
        // Added OVER the home screen rather than replacing it, so dismissing is instant and the
        // home screen never has to be rebuilt. content is a FrameLayout, so this stacks on top.
        content.addView(new ScreensaverScreen(this, bmp, this::dismissScreensaver),
                new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void dismissScreensaver() {
        if (!screensaverShowing) return;
        wakeScreen("touch");               // v2.0-rc11: undo deep sleep before revealing anything
        screensaverShowing = false;
        diag.event("screensaver dismissed by touch");
        // Remove the overlay only — index 0 is the idle surface underneath, untouched.
        for (int i = content.getChildCount() - 1; i >= 0; i--) {
            if (content.getChildAt(i) instanceof ScreensaverScreen) content.removeViewAt(i);
        }
        // ARMING SITE 3 OF 3. Full delay even in idle-first: somebody just physically touched
        // this terminal, so give them the same grace period the home screen gets rather than
        // dropping the image back over their hand.
        armScreensaver();
    }

    // =========================================================================================
    // MODE 1 — Table Pay
    // =========================================================================================

    private void showPin(String errorMessage) {
        if (pinScreen != null) pinScreen.wipe();
        pinScreen = new PinScreen(this, errorMessage, new PinScreen.Listener() {
            @Override public void onPinEntered(char[] pin, int length) {
                submitPin(pin, length);
            }
            @Override public void onCancel() {
                if (pinScreen != null) pinScreen.wipe();
                showHome();
            }
        });
        setScreen(pinScreen);
    }

    /**
     * Validate the PIN server-side.
     *
     * The char[] is copied into a String only because org.json cannot build a body any other
     * way, and the screen's buffer is wiped the instant we have it. Nothing about the PIN is
     * logged, stored, or put in Diagnostics — see the class comment on PinScreen for the honest
     * limits of that.
     */
    private void submitPin(char[] pin, int length) {
        final String entered = new String(pin, 0, length);
        if (pinScreen != null) pinScreen.wipe();

        showStatus("Checking…", "");
        sb.async(() -> api.staffLogin(entered), new SupabaseClient.Result<StaffSession>() {
            @Override public void onSuccess(StaffSession session) {
                if (session == null) {
                    showPin("PIN not recognised");
                    return;
                }
                if (!session.canTakePayment) {
                    showPin(session.name + " is not permitted to take payments");
                    return;
                }
                staff = session;
                diag.staffName = session.name;
                diag.event("staff signed in: " + session.name);
                showTables();
            }
            @Override public void onError(String message) {
                diag.lastRpcError = message;
                showPin(shortError(message));
            }
        });
    }

    private void showTables() {
        tableScreen = new TableListScreen(this, staff == null ? null : staff.name,
                new TableListScreen.Listener() {
                    @Override public void onTableChosen(OpenTable t) { startTablePayment(t); }
                    @Override public void onRefresh() { loadTables(); }
                    @Override public void onBack() { showHome(); }
                });
        setScreen(tableScreen);
        tableScreen.setTables(null, null);
        loadTables();
        // Keep it live while it is up (setScreen already cleared any prior schedule).
        tablesPoll.postDelayed(tablesPollTick, TABLES_POLL_MS);
    }

    private void loadTables() {
        sb.async(() -> api.openTables(), new SupabaseClient.Result<List<OpenTable>>() {
            @Override public void onSuccess(List<OpenTable> tables) {
                if (tableScreen != null) tableScreen.setTables(tables, null);
            }
            @Override public void onError(String message) {
                diag.lastRpcError = message;
                if (tableScreen != null) {
                    tableScreen.setTables(new ArrayList<>(), shortError(message));
                }
            }
        });
    }

    private void startTablePayment(final OpenTable table) {
        if (staff == null) { showPin(null); return; }
        showStatus("Opening " + table.label + "…", "");

        sb.async(() -> {
            TerminalJob job = api.startTablePayment(table.tableId, staff.staffId, table.label);

            // The claim is REQUIRED, not belt-and-braces: terminal_start_table_payment inserts
            // the row as 'pending', and terminal_commit_tip refuses anything not in
            // ('claimed','tipping'). Skip this and the tip commit fails after the customer has
            // already chosen a tip — the worst possible moment to discover it.
            //
            // Unlike the poll path, a `false` here does NOT mean another terminal won the race
            // (this job was minted for us, seconds ago, in reply to our own call). The realistic
            // cause is idx_tj_one_live_per_terminal — this PAX still holds a live job — and that
            // is worth stopping for rather than pressing on into a commit that cannot succeed.
            if (!api.claimJob(job.jobId)) {
                throw new Exception("This terminal already has a payment in progress. "
                        + "Finish or resolve it before starting another.");
            }
            return job;
        }, new SupabaseClient.Result<TerminalJob>() {
            @Override public void onSuccess(TerminalJob job) { beginJob(job); }
            @Override public void onError(String message) {
                diag.lastRpcError = message;
                showError("Could not start this payment", shortError(message),
                        MainActivity.this::showTables);
            }
        });
    }

    // =========================================================================================
    // MODE 2 — Manual payment
    // =========================================================================================

    private void showAmountScreen() {
        setScreen(new AmountScreen(this, new AmountScreen.Listener() {
            @Override public void onAmountEntered(long baseMinor) { beginManual(baseMinor); }
            // Mis-tapped the home tile — nothing has been entered or charged, so just go back.
            @Override public void onCancel() { showHome(); }
        }));
    }

    private void beginManual(long amountMinor) {
        // No server job: basis == due, and there is nothing to commit a tip to. The write-ahead
        // log still gets an intent before the controller launches, so a crash mid-charge is
        // visible to the operator afterwards even though no row exists to reconcile against.
        activeJob = TerminalJob.manual(amountMinor, manualTipConfig);
        activeReference = launchedWithReference != null ? launchedWithReference : "PAXPAY-MANUAL";
        diag.currentJobId = null;
        diag.event("manual payment " + Money.format(amountMinor));
        showTip();
    }

    /** Tear the ambient poller down. Only for pos_dispatch being switched off, and onDestroy. */
    private void stopPolling() {
        if (poller != null) { poller.stop(); poller = null; }
    }

    // =========================================================================================
    // The shared payment path — every mode converges here
    // =========================================================================================

    /**
     * A job-backed payment. WHERE IT STARTS DEPENDS ON WHO IS HOLDING THE TERMINAL (v5.5.841).
     *
     * ── TABLE PAY → confirm first ───────────────────────────────────────────────────────────
     * A waiter picked a table on this device and is about to carry it across a room. The confirm
     * screen is the last moment the person who knows which table they are standing at can catch a
     * mis-tap; after it, a wrong table means a stranger is shown another party's bill and charged
     * for it. Unchanged, deliberately.
     *
     * ── POS DISPATCH → straight to the customer-facing flow ─────────────────────────────────
     * The terminal is ALREADY in front of the customer — that is the entire point of dispatching
     * from the till — and the person who chose the check did so on the POS a second ago. A "Hand
     * to customer" button is then asking the customer to confirm a hand-over that already
     * happened, in front of a screen they have not been shown the total on yet.
     *
     * So the order for a pushed job is the one the customer needs:
     *   1. the TOTAL, plainly       — TipScreen states the bill before it offers anything
     *   2. the TIP                  — same screen, under the amount
     *   3. the CHARGE               — via onTipChosen, which commits the tip FIRST
     *
     * ★ This changes only WHERE THE FLOW ENTERS. It does not touch the ordering rule: every path
     *   below still goes showTip → onTipChosen → commitTip → launchCharge, in that order. ★
     */
    private void beginJob(TerminalJob job) {
        // v2.0-rc11: a till just sent a payment to this terminal — light it up BEFORE anything is
        // drawn, so the customer sees the amount rather than a dark panel. Polling continues
        // while asleep (JobPoller is only stopped in onDestroy), which is what makes this work.
        wakeScreen("job " + job.jobId);
        // JobPoller stops itself the moment it claims, so there is nothing to tear down here.
        activeJob = job;
        activeLocalId = null;
        activeReference = job.jobId;
        diag.currentJobId = job.jobId;
        diag.event("job ready: " + job.jobId + " source=" + job.source
                + " due=" + job.dueMinor + " basis=" + job.tipBasisMinor
                + " tipping=" + job.tipConfig.enabled);

        if (job.source == TerminalJob.Source.POS_PUSH) {
            // No hand-over step: the customer is already looking at this screen.
            diag.event("POS-dispatched — skipping hand-over, showing the total");
            showTip();
            return;
        }

        setScreen(new ConfirmScreen(this, job, new ConfirmScreen.Listener() {
            @Override public void onConfirm() { showTip(); }
            @Override public void onCancel() { cancelActiveJob(); }
        }));
    }

    /**
     * The waiter backed out before the customer saw anything. Nothing has been charged and no
     * write-ahead-log row exists yet, so this is a clean, deterministic cancel.
     */
    private void cancelActiveJob() {
        final TerminalJob job = activeJob;
        if (job != null && job.hasServerJob()) {
            final String jobId = job.jobId;
            sb.async(() -> api.reportResult(jobId, OpsApi.STATUS_CANCELLED, null, null, null,
                    0L, "Cancelled on the terminal before the customer saw the bill."), null);
            diag.event("cancelled job " + jobId);
        }
        activeJob = null;
        diag.currentJobId = null;
        if (staff != null) showTables(); else showHome();
    }

    /** Tipping disabled is a FIRST-CLASS state: the screen is skipped entirely, not shown empty. */
    private void showTip() {
        final TerminalJob job = activeJob;
        if (job == null) { showHome(); return; }

        if (!job.tipConfig.enabled) {
            diag.event("tipping disabled — tip screen skipped");
            onTipChosen(0L);
            return;
        }
        setScreen(new TipScreen(this, job.tipBasisMinor, job.dueMinor, job.tipConfig,
                this::onTipChosen));
    }

    /**
     * ★ THE ORDERING RULE LIVES HERE ★
     *
     * The single funnel between "the customer chose" and "the card is touched". Both branches
     * persist the intent BEFORE any charge:
     *
     *   job-backed → terminal_commit_tip writes tip + charge to the database, and only a
     *                SUCCESSFUL commit proceeds to the controller
     *   manual     → no server row exists, so the local write-ahead log is the record, written
     *                in launchCharge() before the controller intent goes out
     *
     * A failed commit does NOT charge. That is not an edge case to route around later.
     */
    private void onTipChosen(long chosenTip) {
        final TerminalJob job = activeJob;
        if (job == null) { showHome(); return; }

        job.setTipMinor(chosenTip);
        diag.event("tip chosen: " + chosenTip + " (due " + job.dueMinor + ")");

        if (!job.hasServerJob()) {
            launchCharge();
            return;
        }

        showStatus("Recording the tip…", "Before anything is charged");
        sb.async(() -> {
            long charge = api.commitTip(job.jobId, job.tipMinor());
            job.setServerCharge(charge);   // throws if it is not due + tip
            return charge;
        }, new SupabaseClient.Result<Long>() {
            @Override public void onSuccess(Long charge) {
                diag.event("tip committed, server charge = " + charge);
                launchCharge();
            }
            @Override public void onError(String message) {
                diag.lastRpcError = message;
                diag.event("commit_tip FAILED: " + message);
                // Nothing has been charged and nothing will be. Say so in as many words: an
                // operator who is not certain will try again on the POS and double-charge.
                showRetryableError("The tip could not be recorded",
                        "NO CARD HAS BEEN CHARGED.\n\n" + shortError(message),
                        () -> onTipChosen(job.tipMinor()));
            }
        });
    }

    /**
     * The ONLY place in this app that launches the STS controller.
     *
     * By the time we get here the money is already recorded — server-side for a job, locally for
     * a manual sale. The write-ahead log moves INTENT → SENT immediately before the launch, so a
     * process death from this line onwards is recoverable as "outcome unknown" rather than as
     * nothing at all.
     */
    private void launchCharge() {
        final TerminalJob job = activeJob;
        if (job == null) { showHome(); return; }

        long charge = job.chargeMinor();
        if (charge < 0) {
            // Defensive: a job-backed payment can only reach here after a successful commit.
            showRetryableError("Amount not confirmed",
                    "The amount to charge was not confirmed by the server. No card has been "
                            + "charged.", () -> onTipChosen(job.tipMinor()));
            return;
        }

        activeLocalId = job.jobId != null ? job.jobId : "MANUAL-" + UUID.randomUUID();

        // ── write-ahead: INTENT ────────────────────────────────────────────────────────────
        jobLog.writeIntent(job, activeLocalId);
        diag.unresolvedPayments = jobLog.unfinishedCount();

        statusScreen = new StatusScreen(this, charge);
        setScreen(statusScreen);

        G8SaleRequest request = new G8SaleRequest(
                job.dueMinor, job.tipMinor(), job.currency,
                activeReference == null ? activeLocalId : activeReference,
                // The job id IS the idempotency key. One logical sale, one key, surviving a
                // retry — which is why it is minted server-side and not with randomUUID().
                activeLocalId,
                // The server job this charge belongs to — null ONLY for a manual sale, which
                // the real charge path refuses cleanly (it charges BY job row, nothing else).
                job.jobId);

        // Belt and braces on the one number that reaches the card.
        if (request.totalMinor != charge) {
            jobLog.markReported(activeLocalId);   // nothing was sent; do not leave a phantom row
            showRetryableError("Amount mismatch",
                    "The terminal computed " + Money.format(request.totalMinor, job.currency)
                            + " but the confirmed charge is " + Money.format(charge, job.currency)
                            + ". No card has been charged.",
                    () -> onTipChosen(job.tipMinor()));
            return;
        }

        flow = new PaymentFlow(this, diag, g8, new PaymentFlow.Listener() {
            @Override public void onConnecting() {
                setStatus("Connecting to the terminal…", "Total " + Money.format(charge, job.currency));
            }
            @Override public void onDeviceConnected() {
                setStatus("Terminal ready", "Starting the payment…");
            }
            @Override public void onDispatching() {
                markDispatched(job);
            }
            @Override public void onTransactionStarted(String transactionId) {
                setStatus("Present card", "Total " + Money.format(charge, job.currency));
            }
            @Override public void onResult(G8TransactionResult result) {
                handleResult(result);
            }
            @Override public void onFailure(String message, PaymentFlow.Outcome outcome) {
                handleFailure(message, outcome);
            }
        });

        Intent launch = flow.start(request);
        if (launch == null) {
            // start() already reported the failure through onFailure (SAFE_NO_CHARGE), which has
            // resolved the log row. Nothing to launch.
            return;
        }

        // NOTE: the write-ahead log is NOT moved to SENT here. Launching the controller is not
        // the point of no return — the controller can sit there and time out without a single
        // byte reaching the processor. SENT is stamped in markDispatched(), on the callback that
        // fires as the start-transaction request is issued, which is the moment the outcome
        // actually stops being knowable. This keeps the device's view and the server's
        // charging_unsent/charging split in agreement about what "dispatched" means.
        controllerLauncher.launch(launch);
    }

    /**
     * ★ THE POINT OF NO RETURN — local write-ahead stamped here ★
     *
     * The local write-ahead log is stamped SENT so a process death from here on resolves to
     * "unknown" (never a silent clean cancel). That is unconditional.
     *
     * The SERVER-side charging_unsent → charging transition is subtler, and depends on which
     * charge path is live:
     *
     *   • REAL path (ServerG8CloudClient → terminal-job-charge): that edge function does its OWN
     *     CAS `SET status='charging' WHERE status='charging_unsent'` as the first act of 'start',
     *     BEFORE it ever touches Ryft — that CAS is the idempotency layer that guarantees exactly
     *     one caller reaches the processor. If we ALSO flipped the row to 'charging' here, we would
     *     win that transition first and the charge function would find 'charging', conclude another
     *     caller is already in flight, and return `in_flight` WITHOUT calling Ryft — the card screen
     *     never appears and the bill sits unpaid. So on the real path we must NOT call terminal_job_sent;
     *     the charge function owns the transition, and it flips to 'charging' at exactly the moment
     *     Ryft is engaged, which is precisely what the sweeper invariant needs.
     *
     *   • SIMULATED path (StubG8CloudClient): nothing else advances the row, so we keep stamping it
     *     here. terminal_jobs_sweep turns an expired `charging_unsent` row into **cancelled**, so a
     *     stubbed charge that never reached 'charging' would be written down as a clean cancellation
     *     — a lost sale that never surfaces. Hence the three retries: expensive to miss.
     */
    private void markDispatched(final TerminalJob job) {
        if (activeLocalId == null) return;
        jobLog.markSent(activeLocalId);
        diag.event("dispatch — point of no return");

        // Real path: terminal-job-charge's own CAS owns charging_unsent -> charging (see above).
        if (!BuildVersion.SIMULATED) {
            diag.event("job_sent skipped — charge fn owns charging_unsent -> charging");
            return;
        }

        if (!job.hasServerJob()) return;
        final String jobId = job.jobId;
        sb.async(() -> {
            Exception last = null;
            for (int attempt = 1; attempt <= 3; attempt++) {
                try {
                    if (api.jobSent(jobId, null)) return Boolean.TRUE;
                    // ok=false means the row was not in charging_unsent — already moved on, or
                    // already swept. Retrying cannot change that, so stop.
                    return Boolean.FALSE;
                } catch (Exception e) {
                    last = e;
                    try { Thread.sleep(400L * attempt); } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            if (last != null) throw last;
            return Boolean.FALSE;
        }, new SupabaseClient.Result<Boolean>() {
            @Override public void onSuccess(Boolean ok) {
                diag.event("job_sent -> " + (Boolean.TRUE.equals(ok) ? "charging" : "not applied"));
            }
            @Override public void onError(String message) {
                // Loud in diagnostics: this is the state where the sweeper could mis-resolve.
                diag.lastRpcError = "job_sent: " + message;
                diag.event("job_sent FAILED after retries: " + message);
            }
        });
    }

    // -----------------------------------------------------------------------------------------
    // Outcomes
    // -----------------------------------------------------------------------------------------

    private void handleResult(G8TransactionResult result) {
        final TerminalJob job = activeJob;
        final String localId = activeLocalId;
        if (job == null || localId == null) return;

        boolean approved = result != null && result.approved;
        long reported = approved ? job.chargeMinor() : 0L;

        // ── write-ahead: RESULT, written BEFORE we try to tell anyone ──────────────────────
        jobLog.writeResult(localId, approved,
                result == null ? null : result.transactionId,
                result == null ? null : result.authCode,
                cardJson(result),
                result == null ? null : result.declineReason,
                reported);

        if (job.hasServerJob()) {
            final String status = approved ? OpsApi.STATUS_APPROVED : OpsApi.STATUS_DECLINED;
            final String txn = result == null ? null : result.transactionId;
            final String auth = result == null ? null : result.authCode;
            final String card = cardJson(result);
            final String declineReason = result == null ? null : result.declineReason;
            sb.async(() -> api.reportResult(job.jobId, status, txn, auth, card,
                    reported, declineReason), new SupabaseClient.Result<Boolean>() {
                @Override public void onSuccess(Boolean ok) {
                    if (Boolean.TRUE.equals(ok)) {
                        jobLog.markReported(localId);
                    } else {
                        jobLog.noteAttempt(localId, "server rejected the result");
                    }
                    diag.unresolvedPayments = jobLog.unfinishedCount();
                }
                @Override public void onError(String message) {
                    // The charge is a FACT and it is safely in the log. RecoveryRunner replays it
                    // — forever, no staleness floor — the next time this app can reach the server.
                    jobLog.noteAttempt(localId, message);
                    diag.lastRpcError = message;
                    diag.unresolvedPayments = jobLog.unfinishedCount();
                }
            });
        } else {
            jobLog.closeLocal(localId);
            diag.unresolvedPayments = jobLog.unfinishedCount();
        }

        setScreen(new ResultScreen(this, job.dueMinor, job.tipMinor(), result, this::finishPayment));

        // v2.0-rc6 — AUTO-RETURN. The terminal is customer-facing at the counter; staff must
        // not have to touch it between payments. Show the outcome long enough to read (a
        // decline gets longer so the reason lands), then return to the payment screen by
        // ourselves so the NEXT payment can flow immediately. Guarded on activeLocalId: if
        // staff tapped Done first (finishPayment nulls it) or a new payment already started
        // (different id), this delayed call is a no-op. The Outcome-unknown screen is NOT
        // this path — it still requires a human, by design.
        final long autoMs = approved ? 2_000L : 4_500L;
        ui.postDelayed(() -> {
            if (localId.equals(activeLocalId)) finishPayment();
        }, autoMs);
    }

    private void handleFailure(String message, PaymentFlow.Outcome outcome) {
        final TerminalJob job = activeJob;
        final String localId = activeLocalId;

        if (localId == null || job == null) {
            // Failed before anything was written (e.g. no controller installed).
            showError("Payment not completed", message, this::finishPayment);
            return;
        }

        if (outcome == PaymentFlow.Outcome.SAFE_NO_CHARGE) {
            // Deterministically safe. Resolve it and let the operator try again cleanly.
            if (job.hasServerJob()) {
                sb.async(() -> api.reportResult(job.jobId, OpsApi.STATUS_CANCELLED, null, null,
                        null, 0L, message), null);
            }
            jobLog.markReported(localId);
            diag.unresolvedPayments = jobLog.unfinishedCount();
            showError("Payment not completed", message, this::finishPayment);
            return;
        }

        // ☠ UNKNOWN. Do not resolve the log row — it stays SENT so that a restart surfaces it
        // again if this report does not land. Tell the server so it lands in the human queue,
        // and block this terminal behind the unresolved screen.
        if (job.hasServerJob()) {
            sb.async(() -> api.reportResult(job.jobId, OpsApi.STATUS_UNKNOWN,
                    diag.lastTransactionId, null, null, job.chargeMinor(), message), null);
        }
        diag.unresolvedPayments = jobLog.unfinishedCount();
        diag.event("UNKNOWN outcome — blocking terminal");

        List<JobLog.Entry> blocking = new ArrayList<>();
        JobLog.Entry e = jobLog.find(localId);
        if (e != null) blocking.add(e);
        activeJob = null;
        activeLocalId = null;
        if (blocking.isEmpty()) showError("Payment outcome unknown", message, this::finishPayment);
        else showUnresolved(blocking);
    }

    /** Back to a safe idle state, replaying anything the log still owes on the way. */
    private void finishPayment() {
        if (flow != null) { flow.dispose(); flow = null; }
        activeJob = null;
        activeLocalId = null;
        activeReference = null;
        statusScreen = null;
        diag.currentJobId = null;
        // The poller stopped itself when it claimed this job. Restart it now rather than waiting
        // up to a minute for the heartbeat — the next customer may already be at the counter.
        ensureAmbientPolling();
        // Opportunistic replay: a result that failed to report a moment ago usually lands now.
        runRecoveryThenContinue();
    }

    private static String cardJson(G8TransactionResult r) {
        if (r == null) return null;
        try {
            JSONObject j = new JSONObject();
            if (r.scheme != null) j.put("scheme", r.scheme);
            // Masked PAN only — this app never sees, stores or transmits a full card number.
            if (r.maskedPan != null) j.put("masked_pan", r.maskedPan);
            j.put("simulated", r.simulated);
            return j.length() == 0 ? null : j.toString();
        } catch (Exception e) {
            return null;
        }
    }

    // =========================================================================================
    // Recovery / unresolved
    // =========================================================================================

    private void showUnresolved(final List<JobLog.Entry> entries) {
        // NOT stopPolling(): the poller is ambient now, and posJobBusyReason() already refuses
        // to claim while the write-ahead log has anything unfinished. Killing it here would mean
        // nothing restarts it once the human clears the queue.
        if (entries == null || entries.isEmpty()) { showHome(); return; }

        setScreen(new UnresolvedScreen(this, entries, new UnresolvedScreen.Listener() {
            @Override public void onAcknowledge(JobLog.Entry entry) {
                recovery.acknowledge(entry.jobId, remaining -> {
                    diag.unresolvedPayments = jobLog.unfinishedCount();
                    if (remaining != null && !remaining.isEmpty()) showUnresolved(remaining);
                    else showHome();
                });
            }
            @Override public void onDiagnostics() { showDiagnostics(); }
        }));
    }

    // =========================================================================================
    // Chrome + generic screens
    // =========================================================================================

    private void buildChrome() {
        LinearLayout root = Ui.screen(this);

        if (BuildVersion.SIMULATED) root.addView(Ui.simulatedBanner(this));

        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        diagFooter = Ui.diagnosticsFooter(this, diag.summaryLine(), v -> showDiagnostics());
        root.addView(diagFooter, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    private void refreshFooter() {
        if (diagFooter != null) diagFooter.setText(diag.summaryLine());
    }

    private void setScreen(View view) {
        // v5.5.838 — THE ONLY PLACE THE SCREENSAVER TIMER IS EVER CANCELLED. Every screen in this
        // class arrives through here, so leaving the home screen disarms the idle timer by
        // construction. A payment screen cannot be covered by a screensaver because by the time
        // it is on display the timer no longer exists. See armScreensaver().
        disarmScreensaver();
        wakeScreen("screen change");    // v2.0-rc11: never draw a screen onto a dark panel
        // Leaving any screen stops the open-tables poll; showTables() re-arms it. (The getParent()
        // check in the tick is the backstop; removing here stops it promptly.)
        tablesPoll.removeCallbacksAndMessages(null);
        screensaverShowing = false;
        sleepOverlay = null;            // content.removeAllViews() below drops it with everything else
        content.removeAllViews();
        content.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        refreshFooter();
    }

    private void probeControllerAtBoot() {
        ControllerResolver.Resolution res = ControllerResolver.resolve(this);
        diag.controllerPackage = res.packageName;
        diag.launchIntentFound = res.launchIntent != null;
        diag.controllerProbeLog = res.probeLog;
        diag.event(res.found()
                ? ("controller present: " + res.packageName + (res.isSandbox() ? " (SANDBOX)" : ""))
                : "controller NOT present at boot");
    }

    private void showPairing(String errorMessage, boolean busy) {
        setScreen(new PairingScreen(this, prefs.claimCode(), prefs.status(), errorMessage, busy,
                new PairingScreen.Listener() {
                    @Override public void onRefresh() {
                        showPairing(null, true);
                        refreshPairing(true);
                    }
                    @Override public void onDiagnostics() { showDiagnostics(); }
                }));
    }

    private void showStatus(String headline, String detail) {
        statusScreen = new StatusScreen(this, 0L);
        statusScreen.setStatus(headline, detail == null ? "" : detail);
        setScreen(statusScreen);
    }

    private void setStatus(String headline, String detail) {
        if (statusScreen != null) statusScreen.setStatus(headline, detail);
    }

    /** Failure screen. Deliberately verbose — this device is tested without a debugger attached. */
    private void showError(String title, String message, Runnable onDismiss) {
        setScreen(errorView(title, message, "Start again", onDismiss, null));
    }

    /**
     * Same, plus a retry — offered ONLY where retrying is provably safe.
     *
     * Every caller of this method is a failure that happened BEFORE the controller was launched,
     * so "Try again" cannot double-charge. A failure after the card was touched never reaches
     * here; it goes to the unresolved screen, which has no retry button at all.
     */
    private void showRetryableError(String title, String message, Runnable onRetry) {
        setScreen(errorView(title, message, "Try again", onRetry, this::abandonActiveJob));
    }

    /**
     * Give up on a payment that never reached the card.
     *
     * activeLocalId == null proves nothing was written to the write-ahead log, which in this
     * class means the controller was never launched — so cancelling is deterministic and safe.
     */
    private void abandonActiveJob() {
        final TerminalJob job = activeJob;
        if (job != null && job.hasServerJob() && activeLocalId == null) {
            sb.async(() -> api.reportResult(job.jobId, OpsApi.STATUS_CANCELLED, null, null, null,
                    0L, "Abandoned on the terminal before the card was presented."), null);
            diag.event("abandoned job " + job.jobId);
        }
        finishPayment();
    }

    private void showFatal(String title, String message) {
        setScreen(errorView(title, message, null, null, null));
    }

    private View errorView(String title, String message, String primaryLabel,
                           Runnable onPrimary, Runnable onSecondary) {
        ScrollView scroller = new ScrollView(this);
        scroller.setBackgroundColor(Ui.BG);

        LinearLayout root = Ui.screen(this);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(Ui.dp(this, 22), Ui.dp(this, 26), Ui.dp(this, 22), Ui.dp(this, 22));

        TextView icon = Ui.text(this, "!", 50f, Ui.DANGER, true);
        icon.setGravity(Gravity.CENTER);
        root.addView(icon);

        TextView head = Ui.text(this, title, 23f, Ui.TEXT, true);
        head.setGravity(Gravity.CENTER);
        root.addView(head);
        root.addView(Ui.spacer(this, 14));

        TextView body = Ui.text(this, message, 15f, Ui.MUTED, false);
        body.setGravity(Gravity.CENTER);
        root.addView(body);
        root.addView(Ui.spacer(this, 26));

        if (primaryLabel != null && onPrimary != null) {
            root.addView(Ui.primaryButton(this, primaryLabel, v -> onPrimary.run()),
                    Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 68)));
            root.addView(Ui.spacer(this, 10));
        }
        if (onSecondary != null) {
            root.addView(Ui.secondaryButton(this, "Cancel this payment", v -> onSecondary.run()),
                    Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 60)));
            root.addView(Ui.spacer(this, 10));
        }
        root.addView(Ui.secondaryButton(this, "Diagnostics", v -> showDiagnostics()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 60)));

        scroller.addView(root);
        return scroller;
    }

    private void showDiagnostics() {
        diag.unresolvedPayments = jobLog == null ? 0 : jobLog.unfinishedCount();
        final View previous = content.getChildCount() > 0 ? content.getChildAt(0) : null;
        setScreen(new DiagnosticsScreen(this, diag.fullReport(), () -> {
            if (previous != null) setScreen(previous);
            else showHome();
        }));
    }

    /** Null-safe equality — both null counts as the same. */
    private static boolean sameString(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    /** Trim a server error to something an operator can act on, keeping the detail in diagnostics. */
    private static String shortError(String message) {
        if (message == null) return "Unknown error";
        if (SupabaseClient.isSessionLost(message)) {
            return "This terminal's session was lost. It may need re-pairing.";
        }
        return message.length() > 220 ? message.substring(0, 220) + "…" : message;
    }
}

package co.posup.rpos.paxpay;

import android.content.Intent;
import android.os.Bundle;
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
import co.posup.rpos.paxpay.g8.StubG8CloudClient;
import co.posup.rpos.paxpay.model.OpenTable;
import co.posup.rpos.paxpay.model.Pairing;
import co.posup.rpos.paxpay.model.StaffSession;
import co.posup.rpos.paxpay.model.TerminalJob;
import co.posup.rpos.paxpay.net.OpsApi;
import co.posup.rpos.paxpay.net.SupabaseClient;
import co.posup.rpos.paxpay.store.JobLog;
import co.posup.rpos.paxpay.store.Prefs;
import co.posup.rpos.paxpay.ui.AmountScreen;
import co.posup.rpos.paxpay.ui.ConfirmScreen;
import co.posup.rpos.paxpay.ui.DiagnosticsScreen;
import co.posup.rpos.paxpay.ui.HomeScreen;
import co.posup.rpos.paxpay.ui.PairingScreen;
import co.posup.rpos.paxpay.ui.PinScreen;
import co.posup.rpos.paxpay.ui.ResultScreen;
import co.posup.rpos.paxpay.ui.StatusScreen;
import co.posup.rpos.paxpay.ui.TableListScreen;
import co.posup.rpos.paxpay.ui.TipScreen;
import co.posup.rpos.paxpay.ui.Ui;
import co.posup.rpos.paxpay.ui.UnresolvedScreen;
import co.posup.rpos.paxpay.ui.WaitingForPosScreen;

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
    private WaitingForPosScreen waitingScreen;
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

    // =========================================================================================
    // Lifecycle
    // =========================================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A payment terminal must not dim or sleep mid-transaction.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        prefs = new Prefs(this);
        jobLog = new JobLog(this);
        sb = new SupabaseClient(this, prefs);
        api = new OpsApi(sb);
        recovery = new RecoveryRunner(sb, api, jobLog, diag);

        // ── the ONE construction site for the G8 client ─────────────────────────────────────
        // Swap StubG8CloudClient for the real HTTP implementation here and nothing else in the
        // app needs to change. Then set BuildVersion.SIMULATED = false.
        g8 = new StubG8CloudClient();

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

        // Self-update, exactly as :mpos does (throttled; no-op when already current).
        updateChecker = new UpdateChecker(this);
        content.postDelayed(() -> updateChecker.check(false), 8000);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (updateChecker != null) updateChecker.check(false);
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

    private void showHome() {
        stopPolling();
        staff = null;
        diag.staffName = null;
        diag.currentJobId = null;
        activeJob = null;
        activeLocalId = null;

        setScreen(new HomeScreen(this, prefs.label(), jobLog.unfinishedCount(),
                new HomeScreen.Listener() {
                    @Override public void onTablePay() { showPin(null); }
                    @Override public void onManualPayment() { showAmountScreen(); }
                    @Override public void onWaitForPos() { showWaitingForPos(); }
                    @Override public void onReviewUnresolved() {
                        showUnresolved(jobLog.unfinished());
                    }
                }));
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
        setScreen(new AmountScreen(this, this::beginManual));
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

    // =========================================================================================
    // MODE 3 — Waiting for POS
    // =========================================================================================

    private void showWaitingForPos() {
        final String deviceId = prefs.deviceId();
        if (deviceId == null) {
            showError("Not paired", "This terminal is not paired to a venue yet.", this::boot);
            return;
        }
        waitingScreen = new WaitingForPosScreen(this, prefs.label(), this::showHome);
        setScreen(waitingScreen);

        poller = new JobPoller(sb, api, diag, deviceId, new JobPoller.Listener() {
            @Override public void onJobClaimed(TerminalJob job) { beginJob(job); }
            @Override public void onIdle(String detail) {
                if (waitingScreen != null) waitingScreen.setStatus(detail);
            }
            @Override public void onProblem(String message) {
                showError("Cannot listen for payments", shortError(message),
                        MainActivity.this::showHome);
            }
        });
        poller.start();
    }

    private void stopPolling() {
        if (poller != null) { poller.stop(); poller = null; }
        waitingScreen = null;
    }

    // =========================================================================================
    // The shared payment path — every mode converges here
    // =========================================================================================

    /** A job-backed payment: show the waiter what they are about to hand over. */
    private void beginJob(TerminalJob job) {
        stopPolling();
        activeJob = job;
        activeLocalId = null;
        activeReference = job.jobId;
        diag.currentJobId = job.jobId;
        diag.event("job ready: " + job.jobId + " due=" + job.dueMinor
                + " basis=" + job.tipBasisMinor);

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
                activeLocalId);

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
     * ★ THE POINT OF NO RETURN — both records stamped together ★
     *
     * Two things must be true from here on, and they must not disagree:
     *   1. the local write-ahead log says SENT, so a process death resolves to "unknown"
     *   2. the server row says `charging`, NOT `charging_unsent`
     *
     * (2) is the one that bites. terminal_jobs_sweep turns an expired `charging_unsent` row into
     * **cancelled** — "tip taken but request never dispatched". If this terminal dispatches a
     * charge and fails to say so, a real card payment gets written down as a clean cancellation
     * the moment the claim lease runs out. Nobody ever goes looking for a cancelled job, so that
     * is a lost sale that never surfaces.
     *
     * Hence the retries: this is a fire-and-forget call whose failure is expensive, so it gets
     * three goes on the background thread rather than one. If all three fail the payment still
     * proceeds — refusing to charge because a status ping failed would be worse — and the result
     * write afterwards carries the truth anyway.
     */
    private void markDispatched(final TerminalJob job) {
        if (activeLocalId == null) return;
        jobLog.markSent(activeLocalId);
        diag.event("dispatch — point of no return");

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
        stopPolling();
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

    /** Trim a server error to something an operator can act on, keeping the detail in diagnostics. */
    private static String shortError(String message) {
        if (message == null) return "Unknown error";
        if (SupabaseClient.isSessionLost(message)) {
            return "This terminal's session was lost. It may need re-pairing.";
        }
        return message.length() > 220 ? message.substring(0, 220) + "…" : message;
    }
}

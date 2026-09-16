import Foundation
import Network
import WebKit

/// PrinterBridge: window.RposPrinter for the iOS shell (v5.8.83, POS build 5).
///
/// Until this build the iPad app had no printer code: every print was queued to
/// Supabase print_jobs for a LAN print agent, and a venue with no agent (the UK
/// test venue, 16 Sep 2026) printed nothing. Now the iPad prints exactly as the
/// Android till does: src/lib/printer.js builds the ESC/POS bytes, calls
/// window.RposPrinter.print(base64, ip, port, callbackId), and this class opens a
/// TCP connection to the printer on the venue Wi-Fi (port 9100), sends the bytes
/// and answers through window.__rposPrintCallback(callbackId, ok, error). The
/// web app's feature detection is the truthiness of window.RposPrinter, so the
/// object is only injected on targets with RPOSAllowsPrinting (Config.swift),
/// which must also declare NSLocalNetworkUsageDescription: iOS asks once for
/// local network access the first time the app reaches a LAN address.
///
/// Same API as android/.../printer/PrinterBridge.java and the same wire
/// behaviour as its NetworkPrinter (connect timeout, write, close). The old
/// RestaurantOS/Printer draft was the starting point.
final class PrinterBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "rposPrinter"

    /// Injected at document start so the web app sees the bridge before it
    /// feature detects. isAvailable() returns the string 'true' like Android.
    static let injectionScript = WKUserScript(
        source: """
        (function () {
          window.RposPrinter = {
            isAvailable: function () { return 'true'; },
            print: function (base64, ip, port, callbackId) {
              window.webkit.messageHandlers.rposPrinter.postMessage({
                action: 'print', base64: String(base64), ip: String(ip), port: Number(port) || 9100, callbackId: String(callbackId)
              });
            },
            openCashDrawer: function (ip, port, callbackId) {
              window.webkit.messageHandlers.rposPrinter.postMessage({
                action: 'openCashDrawer', ip: String(ip), port: Number(port) || 9100, callbackId: String(callbackId)
              });
            }
          };
          console.log('[RPOS] Native printer bridge ready (iOS)');
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    private weak var webView: WKWebView?
    private let printer = NetworkPrinter()

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        let callbackId = body["callbackId"] as? String
        let ip = (body["ip"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let port = UInt16(truncatingIfNeeded: (body["port"] as? NSNumber)?.intValue ?? 9100)
        guard !ip.isEmpty else {
            notify(callbackId, ok: false, error: "No printer IP address")
            return
        }

        switch action {
        case "print":
            guard let base64 = body["base64"] as? String, let data = Data(base64Encoded: base64), !data.isEmpty else {
                notify(callbackId, ok: false, error: "Invalid print data")
                return
            }
            printer.send(data, to: ip, port: port) { [weak self] result in
                self?.finish(callbackId, result)
            }
        case "openCashDrawer":
            // ESC p 0 25 25: the standard drawer pulse through the receipt printer's RJ12 port.
            printer.send(Data([0x1b, 0x70, 0x00, 0x19, 0x19]), to: ip, port: port) { [weak self] result in
                self?.finish(callbackId, result)
            }
        default:
            notify(callbackId, ok: false, error: "Unknown action \(action)")
        }
    }

    private func finish(_ callbackId: String?, _ result: Result<Void, Error>) {
        switch result {
        case .success: notify(callbackId, ok: true, error: nil)
        case .failure(let error): notify(callbackId, ok: false, error: error.localizedDescription)
        }
    }

    /// window.__rposPrintCallback(callbackId, ok, error), the same call the Android bridge makes.
    private func notify(_ callbackId: String?, ok: Bool, error: String?) {
        guard let callbackId = callbackId else { return }
        let idJSON = Self.jsString(callbackId)
        let errJSON = Self.jsString(error ?? "")
        let js = "window.__rposPrintCallback && window.__rposPrintCallback(\(idJSON), \(ok), \(errJSON));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    /// A JS string literal: JSON quoting, so an error text with quotes or newlines can never break the call.
    private static func jsString(_ s: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [s]), let text = String(data: data, encoding: .utf8) {
            return String(text.dropFirst().dropLast())   // ["..."] -> "..."
        }
        return "\"\""
    }
}

/// One TCP send to a receipt printer (port 9100 raw printing). Connect and send are
/// bounded by a timeout so a wrong IP or a printer that is off answers with an error
/// instead of a hung callback. Errors are the system's own words ("No route to
/// host", "Connection refused"), which the web app shows on the print queue row.
final class NetworkPrinter {
    private let queue = DispatchQueue(label: "co.posup.rpos.printer", qos: .userInitiated)
    private let timeout: TimeInterval = 8

    func send(_ data: Data, to ipAddress: String, port: UInt16, completion: @escaping (Result<Void, Error>) -> Void) {
        let host = NWEndpoint.Host(ipAddress)
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            completion(.failure(Self.error("Invalid printer port \(port)")))
            return
        }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let connection = NWConnection(host: host, port: nwPort, using: params)
        var done = false
        let finish: (Result<Void, Error>) -> Void = { result in
            if done { return }
            done = true
            // Give the last bytes a moment to leave before the socket closes: some printers drop
            // a tail that arrives with the close.
            self.queue.asyncAfter(deadline: .now() + 0.25) { connection.cancel() }
            completion(result)
        }

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                connection.send(content: data, completion: .contentProcessed { error in
                    if let error = error { finish(.failure(error)) } else { finish(.success(())) }
                })
            case .failed(let error):
                finish(.failure(error))
            case .waiting(let error):
                // No route yet (wrong subnet, printer off, Wi-Fi not joined): report it now
                // rather than waiting out the whole timeout.
                finish(.failure(error))
            case .cancelled:
                finish(.failure(Self.error("Connection cancelled")))
            default:
                break
            }
        }
        connection.start(queue: queue)

        queue.asyncAfter(deadline: .now() + timeout) {
            finish(.failure(Self.error("Print timeout: check the printer IP and that the iPad is on the same Wi-Fi")))
        }
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "NetworkPrinter", code: -1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

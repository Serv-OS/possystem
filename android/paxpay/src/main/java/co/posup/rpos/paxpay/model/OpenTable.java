package co.posup.rpos.paxpay.model;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** One row of terminal_open_tables(). */
public final class OpenTable {

    public final String tableId;
    public final String label;
    public final String sessionId;
    /** Bill total in MINOR units. Long, never a double. */
    public final long totalMinor;
    public final String serverName;
    public final String openedAt;

    public OpenTable(String tableId, String label, String sessionId,
                     long totalMinor, String serverName, String openedAt) {
        this.tableId = tableId;
        this.label = label;
        this.sessionId = sessionId;
        this.totalMinor = totalMinor;
        this.serverName = serverName;
        this.openedAt = openedAt;
    }

    public static List<OpenTable> list(JSONArray arr) {
        List<OpenTable> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject j = arr.optJSONObject(i);
            if (j == null) continue;
            String id = Json.str(j, "table_id");
            if (id == null) continue;
            String label = Json.str(j, "label");
            out.add(new OpenTable(
                    id,
                    label == null ? "Table" : label,
                    Json.str(j, "session_id"),
                    // A table whose total we cannot read is shown at 0 and is NOT payable —
                    // the amount-confirm screen refuses it. Better than inventing a number.
                    Json.optMinor(j, "total_minor", 0L),
                    Json.str(j, "server_name"),
                    Json.str(j, "opened_at")));
        }
        return out;
    }
}

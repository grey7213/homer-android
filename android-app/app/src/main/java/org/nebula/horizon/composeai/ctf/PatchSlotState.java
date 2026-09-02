package org.nebula.horizon.composeai.ctf;

public final class PatchSlotState {
    private PatchSlotState() {}

    public static String inactiveSlot(String active) {
        return "slot-a".equals(active) ? "slot-b" : "slot-a";
    }

    public static String recoverActiveSlot(String active, String pending, String previous) {
        if (pending == null || pending.isEmpty()) return validOrBundled(active);
        return validOrBundled(previous);
    }

    public static String validOrBundled(String value) {
        return "slot-a".equals(value) || "slot-b".equals(value) ? value : "";
    }
}

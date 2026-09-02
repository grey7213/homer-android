package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class PatchSlotStateTest {
    @Test
    public void alternatesSlots() {
        assertEquals("slot-a", PatchSlotState.inactiveSlot(""));
        assertEquals("slot-b", PatchSlotState.inactiveSlot("slot-a"));
        assertEquals("slot-a", PatchSlotState.inactiveSlot("slot-b"));
    }

    @Test
    public void rollsPendingSlotBackToPrevious() {
        assertEquals("slot-a", PatchSlotState.recoverActiveSlot("slot-b", "slot-b", "slot-a"));
        assertEquals("", PatchSlotState.recoverActiveSlot("slot-a", "slot-a", "bundled"));
    }

    @Test
    public void keepsHealthyActiveSlot() {
        assertEquals("slot-b", PatchSlotState.recoverActiveSlot("slot-b", "", "slot-a"));
    }
}

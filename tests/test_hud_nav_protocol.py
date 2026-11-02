"""Unit tests for HKMC / E-GMP windshield HUD navigation protocol encoding."""

import unittest


def encode_hud_primary_frame(
    icon: int,
    direction_deg: int,
    distance_meters: int,
    bar_graph: int,
    alive_counter: int,
    active: bool = True,
) -> bytes:
    """Encode primary maneuver frame (0x29B / 0x562) according to HKMC protocol."""
    data = bytearray(8)
    if active:
        data[0] = icon & 0xFF
        data[1] = 0x00  # Side_Street High
        data[2] = 0x00  # Side_Street Low
        data[3] = int((direction_deg % 360) / 7.5) & 0xFF
        data[4] = (distance_meters >> 8) & 0xFF
        data[5] = distance_meters & 0xFF
        data[6] = 0x00  # Scale unit (meters)

        bar = bar_graph
        if bar > 8 and bar != 0x0F:
            bar = 8
        if distance_meters == 0xFFFF or (bar == 0 and distance_meters > 300):
            bar = 0x0F
        data[7] = ((bar & 0x0F) << 4) | (alive_counter & 0x0F)
    else:
        data[0] = 0x00
        data[1] = 0x00
        data[2] = 0x00
        data[3] = 0x00
        data[4] = 0xFF
        data[5] = 0xFF
        data[6] = 0x00
        data[7] = (0x0F << 4) | (alive_counter & 0x0F)
    return bytes(data)


def encode_hud_cfg_frame(alive_counter: int) -> bytes:
    """Encode HUD Configuration & AR Mode Frame (0x29C / 0x542)."""
    return bytes([
        0x31,  # AR Mode (0x3), HUD Enable (0x1)
        0x00,  # AR Left/Right = 0, AR View = 0
        0x0A,  # Height = 10
        0x0E,  # Rotation = 0, Brightness = 14
        0xFC,  # Content mask: TBT, Traffic, Assist, Safety enabled
        0x11,  # Speed text Large, White
        0x00,
        alive_counter & 0x0F,
    ])


def encode_hud_lane_guidance_isotp(
    num_lanes: int,
    lane_directions: list[int] | None = None,
    lane_recommended: list[int] | None = None,
) -> bytes:
    """Encode 24-byte multi-lane guidance ISO-TP message (0xF1)."""
    clamped_lanes = min(max(num_lanes, 0), 8)
    payload = bytearray(24)
    payload[0] = 0x17  # 23 bytes follow
    payload[1] = 0xF1  # Opcode
    payload[2] = (clamped_lanes & 0x0F) << 4
    payload[3] = 0x00

    dirs = lane_directions or []
    recs = lane_recommended or []

    for i in range(8):
        payload[4 + i] = dirs[i] if i < clamped_lanes and i < len(dirs) else 0x00
        payload[12 + i] = recs[i] if i < clamped_lanes and i < len(recs) else 0x00

    return bytes(payload)


class TestHudNavProtocol(unittest.TestCase):
    """Test suite for HUD navigation CAN and ISO-TP encoding."""

    def test_primary_frame_active_encoding(self) -> None:
        """Verify active primary maneuver frame encoding."""
        # Right turn (icon=3), 90 degrees turn, 250 meters, bar=6, alive=5
        frame = encode_hud_primary_frame(
            icon=3,
            direction_deg=90,
            distance_meters=250,
            bar_graph=6,
            alive_counter=5,
            active=True,
        )
        self.assertEqual(len(frame), 8)
        self.assertEqual(frame[0], 0x03)  # Icon
        self.assertEqual(frame[1], 0x00)  # Side street
        self.assertEqual(frame[2], 0x00)
        self.assertEqual(frame[3], 12)    # 90 / 7.5 = 12
        self.assertEqual(frame[4], 0x00)  # 250 >> 8
        self.assertEqual(frame[5], 250)   # 250 & 0xFF
        self.assertEqual(frame[6], 0x00)  # Meters scale
        self.assertEqual(frame[7], (6 << 4) | 5)  # Bar graph 6 + alive 5

    def test_primary_frame_turn_angles(self) -> None:
        """Verify quantization of turn angles in 7.5-degree steps."""
        test_angles = [
            (0, 0),
            (45, 6),
            (90, 12),
            (180, 24),
            (270, 36),
            (359, 47),
            (360, 0),   # 360 % 360 = 0
            (450, 12),  # 450 % 360 = 90 -> 12
        ]
        for deg, expected_raw in test_angles:
            frame = encode_hud_primary_frame(1, deg, 100, 4, 0, active=True)
            self.assertEqual(frame[3], expected_raw, f"Failed for angle {deg}")

    def test_primary_frame_inactive_defaults(self) -> None:
        """Verify inactive frame uses 0xFFFF distance and 0xF bar graph."""
        frame = encode_hud_primary_frame(0, 0, 0, 0, alive_counter=0x0A, active=False)
        self.assertEqual(frame[0], 0x00)
        self.assertEqual(frame[1], 0x00)
        self.assertEqual(frame[2], 0x00)
        self.assertEqual(frame[3], 0x00)
        self.assertEqual(frame[4], 0xFF)  # Distance high
        self.assertEqual(frame[5], 0xFF)  # Distance low
        self.assertEqual(frame[6], 0x00)
        self.assertEqual(frame[7], 0xFA)  # (0xF << 4) | 0x0A

    def test_primary_frame_bar_graph_auto_fallback(self) -> None:
        """When distance > 300m and bar_graph is 0, bar graph should be 0xF."""
        frame = encode_hud_primary_frame(1, 0, 1200, 0, alive_counter=3, active=True)
        self.assertEqual(frame[7], (0x0F << 4) | 3)

        # But under 300m, bar 0 is valid (immediate turn proximity)
        frame_close = encode_hud_primary_frame(1, 0, 50, 0, alive_counter=3, active=True)
        self.assertEqual(frame_close[7], (0x00 << 4) | 3)

    def test_hud_cfg_frame(self) -> None:
        """Verify HUD Configuration & AR Mode Frame payload."""
        frame = encode_hud_cfg_frame(alive_counter=9)
        self.assertEqual(len(frame), 8)
        self.assertEqual(frame[0], 0x31)  # AR mode + HUD enable
        self.assertEqual(frame[1], 0x00)
        self.assertEqual(frame[2], 0x0A)  # Height 10
        self.assertEqual(frame[3], 0x0E)  # Brightness 14
        self.assertEqual(frame[4], 0xFC)  # Feature mask
        self.assertEqual(frame[5], 0x11)  # Speed text large white
        self.assertEqual(frame[6], 0x00)
        self.assertEqual(frame[7], 0x09)  # Alive counter

    def test_lane_guidance_isotp_payload(self) -> None:
        """Verify 24-byte multi-lane guidance ISO-TP message."""
        dirs = [1, 1, 3, 4]  # 4 lanes: straight, straight, right, sharp right
        recs = [0, 1, 1, 0]  # Middle lanes recommended
        payload = encode_hud_lane_guidance_isotp(4, dirs, recs)

        self.assertEqual(len(payload), 24)
        self.assertEqual(payload[0], 0x17)  # Length
        self.assertEqual(payload[1], 0xF1)  # Opcode
        self.assertEqual(payload[2], 0x40)  # (4 lanes << 4)
        self.assertEqual(payload[3], 0x00)

        # Shapes at bytes 4-11
        self.assertEqual(payload[4:8], bytes([1, 1, 3, 4]))
        self.assertEqual(payload[8:12], bytes([0, 0, 0, 0]))  # Unused lanes padded with 0

        # Highlights at bytes 12-19
        self.assertEqual(payload[12:16], bytes([0, 1, 1, 0]))
        self.assertEqual(payload[16:20], bytes([0, 0, 0, 0]))

        # Trailing padding
        self.assertEqual(payload[20:24], bytes([0, 0, 0, 0]))

    def test_lane_guidance_max_clamp(self) -> None:
        """Verify lane counts > 8 are clamped to 8."""
        payload = encode_hud_lane_guidance_isotp(12)
        self.assertEqual(payload[2], 0x80)  # (8 << 4)

    def test_primary_frame_inactive_distance_overrides_bar(self) -> None:
        """Distance 0xFFFF must force bar graph to 0x0F even if caller passed non-zero bar."""
        frame = encode_hud_primary_frame(1, 0, 0xFFFF, bar_graph=4, alive_counter=7, active=True)
        self.assertEqual(frame[4], 0xFF)
        self.assertEqual(frame[5], 0xFF)
        self.assertEqual(frame[7], (0x0F << 4) | 7)

    def test_lane_guidance_empty_payload(self) -> None:
        """Zero lanes must produce a clean 24-byte payload with 0 lanes and zeroed arrays."""
        payload = encode_hud_lane_guidance_isotp(0)
        self.assertEqual(len(payload), 24)
        self.assertEqual(payload[0], 0x17)
        self.assertEqual(payload[1], 0xF1)
        self.assertEqual(payload[2], 0x00)
        self.assertEqual(payload[3:], bytes(21))

    def test_platform_can_ids(self) -> None:
        """Verify protocol arbitration IDs for E-GMP vs Gen 2 platforms."""
        egmp_primary_id = 0x29B
        egmp_cfg_id = 0x29C
        gen2_primary_id = 0x562
        gen2_cfg_id = 0x542
        isotp_tx_id = 0x6E2
        isotp_fc_id = 0x6C0

        self.assertEqual(egmp_primary_id, 0x29B)
        self.assertEqual(egmp_cfg_id, 0x29C)
        self.assertEqual(gen2_primary_id, 0x562)
        self.assertEqual(gen2_cfg_id, 0x542)
        self.assertEqual(isotp_tx_id, 0x6E2)
        self.assertEqual(isotp_fc_id, 0x6C0)


if __name__ == "__main__":
    unittest.main()



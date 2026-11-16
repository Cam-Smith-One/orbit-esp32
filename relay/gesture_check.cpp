#define ORBIT_GESTURE_CHECK
#include "../main/boards/waveshare/esp32-s3-touch-amoled-1.75/orbit_display.h"

#include <cassert>
#include <cstdio>

int main() {
    using orbit_display::GestureDirection;
    using orbit_display::PageAfterGesture;
    using orbit_display::ShouldHandleMenuClick;

    assert(PageAfterGesture(-1, GestureDirection::Up) == -2);
    assert(PageAfterGesture(-2, GestureDirection::Down) == -1);
    assert(PageAfterGesture(-1, GestureDirection::Down) == -1);
    assert(PageAfterGesture(-2, GestureDirection::Up) == -2);
    assert(PageAfterGesture(-3, GestureDirection::Left) == -3);
    assert(PageAfterGesture(0, GestureDirection::Up) == 0);
    assert(PageAfterGesture(0, GestureDirection::Right) == 0);
    assert(ShouldHandleMenuClick(false));
    assert(!ShouldHandleMenuClick(true));

    std::puts("PASS: Orbit menu gestures use up/down navigation and leave horizontal cards separate");
}

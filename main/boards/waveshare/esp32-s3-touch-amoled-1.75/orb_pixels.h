#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

// Pure renderer shared by the device and the tiny host-side check.
// Unit-sphere normals are cached once. Low-frequency, domain-warped clouds
// move inside the volume; there is no per-pixel trigonometry or allocation.
struct OrbNormal { float x, y, z, edge; };
inline void orb_normals(OrbNormal* out, int width) {
    const float center = width * .5f;
    const float scale = width * .465f;
    const float feather = width * .11f;
    for (int y = 0; y < width; ++y) for (int x = 0; x < width; ++x) {
        float nx = (x + .5f - center) / scale;
        float ny = (y + .5f - center) / scale;
        float r = nx * nx + ny * ny;
        float edge = std::clamp((1.f - r) * feather, 0.f, 1.f);
        edge = edge * edge * (3.f - 2.f * edge);
        out[y * width + x] = {nx, ny, sqrtf(std::max(0.f, 1.f - r)), edge};
    }
}
inline float orb_cloud(float x, float y) {
    // Periodic value noise: four cheap integer hashes and a smooth interpolation.
    // Coordinates supplied by the renderer are positive, so truncation is floor.
    const int ix = static_cast<int>(x), iy = static_cast<int>(y);
    float fx = x - ix, fy = y - iy;
    fx = fx * fx * (3.f - 2.f * fx);
    fy = fy * fy * (3.f - 2.f * fy);
    auto hash = [](int a, int b) {
        uint32_t h = static_cast<uint32_t>(a & 31) * 374761393u +
                     static_cast<uint32_t>(b & 31) * 668265263u;
        h = (h ^ (h >> 13)) * 1274126177u;
        return static_cast<float>((h ^ (h >> 16)) & 65535u) / 65535.f;
    };
    float a = hash(ix, iy), b = hash(ix + 1, iy);
    float c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return (a + fx * (b - a)) * (1.f - fy) + (c + fx * (d - c)) * fy;
}
inline void orb_render(uint16_t* pixels, const OrbNormal* normals, int width, float phase, const float* tint) {
    constexpr float tau = 6.2831853071795864769f;
    phase = std::fmod(phase, tau);
    if (std::abs(phase) < .00001f) phase = 0;
    const float sin_phase = sinf(phase), cos_phase = cosf(phase);
    const float sin_double = sinf(phase + phase), cos_double = cosf(phase + phase);
    constexpr uint16_t background = ((3 >> 3) << 11) | ((7 >> 2) << 5) | (14 >> 3);
    constexpr uint8_t bayer4x4[] = {0, 8, 2, 10, 12, 4, 14, 6,
                                     3, 11, 1, 9, 15, 7, 13, 5};
    // ponytail: one display renderer owns this cache. A second concurrent display
    // would need its own palette; do not add a lock to the audio/UI hot path.
    static uint16_t palette[32][128];
    static float previous_tint[3] = {-1, -1, -1};
    if (previous_tint[0] != tint[0] || previous_tint[1] != tint[1] || previous_tint[2] != tint[2]) {
        const float blue[] = {10.f + .9f * tint[0], 15.f + .55f * tint[1], 15.f + .9f * tint[2]};
        const float cyan_color[] = {110.f + .48f * tint[0], 130.f + .36f * tint[1], 155.f + .39f * tint[2]};
        const float white_color[] = {245.f, 251.f, 255.f};
        for (int m = 0; m < 128; ++m) {
            float mist = m / 127.f;
            float white = std::clamp((mist - .25f) * 1.65f, 0.f, 1.f);
            float cyan = std::clamp(1.f - std::abs(mist - .38f) * 3.f, 0.f, 1.f);
            float color[3];
            for (int c = 0; c < 3; ++c) {
                color[c] = blue[c] + (cyan_color[c] - blue[c]) * cyan * .7f;
                color[c] += (white_color[c] - color[c]) * white;
            }
            for (int light = 0; light < 32; ++light) {
                const float strength = light / 31.f;
                int r = static_cast<int>(std::clamp(3.f + strength * (color[0] - 3.f), 0.f, 255.f));
                int g = static_cast<int>(std::clamp(7.f + strength * (color[1] - 7.f), 0.f, 255.f));
                int b = static_cast<int>(std::clamp(14.f + strength * (color[2] - 14.f), 0.f, 255.f));
                palette[light][m] = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
            }
        }
        std::copy(tint, tint + 3, previous_tint);
    }
    // The cloud is deliberately low frequency. Evaluate just 33×33 samples,
    // then interpolate with integers at full panel resolution (not pixel scaling).
    constexpr int grid = 33;
    uint8_t field[grid][grid];
    for (int y = 0; y < grid; ++y) for (int x = 0; x < grid; ++x) {
        float nx = (x / 32.f - .5f) / .465f;
        float ny = (y / 32.f - .5f) / .465f;
        const float u = 16.f + 2.25f * nx + .45f * sin_phase;
        const float v = 16.f + 2.25f * ny + .55f * cos_phase;
        const float warp = orb_cloud(u, v);
        const float cloud = orb_cloud(u * 1.35f + 1.4f * warp + .35f * cos_double,
                                      v * 1.35f + 1.1f * warp + .35f * sin_double);
        const float detail = orb_cloud(u * 2.6f + .5f * cloud, v * 2.6f + .4f * sin_phase);
        // White mist above saturated blue folds, with a soft luminous horizon.
        float mist = std::clamp(.58f - .48f * ny + 1.05f * (cloud - .5f) +
                                .13f * (detail - .5f), 0.f, 1.f);
        mist = mist * mist * (3.f - 2.f * mist);
        field[y][x] = static_cast<uint8_t>(mist * 254.f);
    }
    for (int y = 0, i = 0; y < width; ++y) {
        int gy = ((2 * y + 1) * 4096) / width;
        int row = gy >> 8, fy = gy & 255;
        for (int x = 0; x < width; ++x, ++i) {
            const auto& n = normals[i];
            if (n.edge == 0) { pixels[i] = background; continue; }
            int gx = ((2 * x + 1) * 4096) / width;
            int col = gx >> 8, fx = gx & 255;
            int a = field[row][col] * (256 - fx) + field[row][col + 1] * fx;
            int b = field[row + 1][col] * (256 - fx) + field[row + 1][col + 1] * fx;
            int mist = ((a * (256 - fy) + b * fy) >> 16) >> 1;
            float ordered = bayer4x4[((y & 3) << 2) | (x & 3)] / 16.f;
            int light = std::min(31, static_cast<int>(n.edge * (.72f + .28f * n.z) * 31.f + ordered));
            pixels[i] = palette[light][mist];
        }
    }
}

#include "../main/boards/waveshare/esp32-s3-touch-amoled-1.75/orb_pixels.h"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

struct Rgb8 { int r, g, b; };

static Rgb8 unpack_rgb565(uint16_t pixel) {
    return {((pixel >> 11) & 31) * 255 / 31,
            ((pixel >> 5) & 63) * 255 / 63,
            (pixel & 31) * 255 / 31};
}

static bool write_contact_sheet(const char* path) {
    constexpr int width = 240;
    constexpr int columns = 3;
    constexpr int gap = 4;
    constexpr float kTau = 6.2831853071795864769f;
    const int height = 2 * width + gap;
    const int sheet_width = columns * width + (columns - 1) * gap;
    const float tint[] = {45, 145, 255};
    const float warm_tint[] = {255, 192, 70};
    const float phases[] = {0, kTau * .25f, kTau * .5f, kTau * .75f};
    std::vector<OrbNormal> normals(width * width);
    std::vector<std::vector<uint16_t>> frames(5, std::vector<uint16_t>(width * width));
    orb_normals(normals.data(), width);
    for (int i = 0; i < 4; ++i) orb_render(frames[i].data(), normals.data(), width, phases[i], tint);
    orb_render(frames[4].data(), normals.data(), width, phases[2], warm_tint);

    auto file = std::fopen(path, "wb");
    if (!file) return false;
    std::fprintf(file, "P6\n# cool phases 0 pi/2 pi 3pi/2; warm phase pi\n%d %d\n255\n",
                 sheet_width, height);
    for (int y = 0; y < height; ++y) for (int x = 0; x < sheet_width; ++x) {
        const int cell_x = x / (width + gap), cell_y = y / (width + gap);
        const int local_x = x % (width + gap), local_y = y % (width + gap);
        unsigned char rgb[] = {3, 7, 14};
        if (cell_x < columns && cell_y < 2 && local_x < width && local_y < width) {
            const int frame = cell_y * columns + cell_x;
            if (frame < static_cast<int>(frames.size())) {
                const Rgb8 color = unpack_rgb565(frames[frame][local_y * width + local_x]);
                rgb[0] = static_cast<unsigned char>(color.r);
                rgb[1] = static_cast<unsigned char>(color.g);
                rgb[2] = static_cast<unsigned char>(color.b);
            }
        }
        if (std::fwrite(rgb, 1, 3, file) != 3) {
            std::fclose(file);
            return false;
        }
    }
    return std::fclose(file) == 0;
}

static void report_timing() {
    constexpr int width = 240;
    constexpr int samples_count = 32;
    constexpr float kTau = 6.2831853071795864769f;
    const float tint[] = {45, 145, 255};
    std::vector<OrbNormal> normals(width * width);
    std::vector<uint16_t> pixels(width * width);
    orb_normals(normals.data(), width);
    for (int i = 0; i < 3; ++i) orb_render(pixels.data(), normals.data(), width, i * .7f, tint);

    std::vector<double> samples;
    samples.reserve(samples_count);
    uint32_t checksum = 0;
    for (int i = 0; i < samples_count; ++i) {
        const float phase = kTau * static_cast<float>(i % 8) / 8.f;
        const auto start = std::chrono::steady_clock::now();
        orb_render(pixels.data(), normals.data(), width, phase, tint);
        const auto finish = std::chrono::steady_clock::now();
        samples.push_back(std::chrono::duration<double, std::milli>(finish - start).count());
        checksum = checksum * 33u + pixels[static_cast<size_t>(i) * 997u % pixels.size()];
    }
    std::sort(samples.begin(), samples.end());
    double mean = 0;
    for (double sample : samples) mean += sample;
    mean /= samples.size();
    const size_t p95_index = (samples.size() * 95 + 99) / 100 - 1;
    std::printf("HOST runtime width=240: mean=%.3f ms p95=%.3f ms checksum=%u\n",
                mean, samples[p95_index], checksum);
}

int main(int argc, char** argv) {
    constexpr int kOrbPixels200 = 200;
    constexpr float kTau = 6.2831853071795864769f;
    const int width = kOrbPixels200;
    if (argc > 2) {
        std::fprintf(stderr, "usage: %s [contact-sheet.ppm]\n", argv[0]);
        return 2;
    }

    std::vector<OrbNormal> n(width * width);
    std::vector<uint16_t> first(width * width), quarter(width * width), half(width * width),
        three_quarter(width * width), warm(width * width), loop(width * width), repeat(width * width);
    float tint[] = {45, 145, 255};
    float warm_tint[] = {255, 192, 70};
    orb_normals(n.data(), width);
    orb_render(first.data(), n.data(), width, 0, tint);
    orb_render(quarter.data(), n.data(), width, kTau * .25f, tint);
    orb_render(half.data(), n.data(), width, kTau * .5f, tint);
    orb_render(three_quarter.data(), n.data(), width, kTau * .75f, tint);
    orb_render(warm.data(), n.data(), width, kTau * .5f, warm_tint);
    orb_render(loop.data(), n.data(), width, kTau, tint);
    orb_render(repeat.data(), n.data(), width, kTau * .25f, tint);

    const uint16_t background = ((3 >> 3) << 11) | ((7 >> 2) << 5) | (14 >> 3);
    assert(first == loop);
    assert(quarter == repeat);
    assert(first != quarter);
    assert(first != warm);

    auto check_frame = [&](const std::vector<uint16_t>& frame) {
        size_t luminous = 0;
        for (size_t i = 0; i < n.size(); ++i) {
            const auto& normal = n[i];
            const Rgb8 color = unpack_rgb565(frame[i]);
            assert(color.r >= 0 && color.r <= 255 && color.g >= 0 && color.g <= 255 &&
                   color.b >= 0 && color.b <= 255);
            if (normal.edge > .8f && color.r > 150 && color.g > 170 && color.b > 200) ++luminous;
            if (normal.edge == 0) assert(frame[i] == background);
        }
        return luminous;
    };

    size_t luminous_pixels = 0;
    for (const auto* frame : {&first, &quarter, &half, &three_quarter, &warm}) {
        luminous_pixels = std::max(luminous_pixels, check_frame(*frame));
    }
    for (const auto& normal : n) {
        assert(std::isfinite(normal.x) && std::isfinite(normal.y) && std::isfinite(normal.z) &&
               std::isfinite(normal.edge));
        assert(normal.edge >= 0 && normal.edge <= 1);
    }

    size_t textured_pixels = 0;
    size_t temporal_changed = 0;
    for (int y = 1; y < width - 1; ++y) for (int x = 1; x < width; ++x) {
        const size_t i = static_cast<size_t>(y) * width + x;
        if (n[i].edge > .8f && n[i - 1].edge > .8f) {
            const Rgb8 here = unpack_rgb565(first[i]);
            const Rgb8 left = unpack_rgb565(first[i - 1]);
            if (std::abs(here.r - left.r) + std::abs(here.g - left.g) + std::abs(here.b - left.b) >= 3) {
                ++textured_pixels;
            }
        }
        const Rgb8 before = unpack_rgb565(first[i]);
        const Rgb8 after = unpack_rgb565(quarter[i]);
        if (std::abs(before.r - after.r) + std::abs(before.g - after.g) + std::abs(before.b - after.b) >= 3) {
            ++temporal_changed;
        }
    }
    assert(luminous_pixels > 500 && "The orb must retain a luminous blue-white cloud");
    assert(textured_pixels > n.size() / 100 && "The orb must retain internal cloud texture");
    assert(temporal_changed > n.size() / 20 && "The orb must visibly change between phases");
    std::printf("HOST quality: luminous=%zu textured-transitions=%zu temporal-changes=%zu/%zu\n",
                luminous_pixels, textured_pixels, temporal_changed, n.size());
    report_timing();

    if (argc == 2 && !write_contact_sheet(argv[1])) {
        std::fprintf(stderr, "could not write contact sheet: %s\n", argv[1]);
        return 1;
    }
    puts("PASS: bounded colors, finite normals, all moods/phases, stable dither, cloud texture, smooth loop");
}

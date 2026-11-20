#pragma once

#include <cstddef>
#include <cstdlib>
#include <functional>
#include <limits>
#include <list>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include "sdkconfig.h"

#if CONFIG_SPIRAM
#include "esp_heap_caps.h"
#endif

/**
 * @brief STL allocator preferring PSRAM on CONFIG_SPIRAM targets so long-lived
 *        catalog/index containers do not drain internal DRAM below the DMA reserve.
 */
template <typename T>
struct PsramAllocator {
    using value_type = T;
    using propagate_on_container_move_assignment = std::true_type;
    using is_always_equal = std::true_type;

    template <typename U>
    struct rebind {
        using other = PsramAllocator<U>;
    };

    constexpr PsramAllocator() noexcept = default;

    template <typename U>
    constexpr PsramAllocator(const PsramAllocator<U>&) noexcept {}

    T* allocate(std::size_t n) {
        if (n == 0) {
            return nullptr;
        }
        if (n > std::numeric_limits<std::size_t>::max() / sizeof(T)) {
            std::abort();
        }
        const std::size_t bytes = n * sizeof(T);
#if CONFIG_SPIRAM
        void* p = heap_caps_malloc_prefer(bytes, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT);
#else
        void* p = std::malloc(bytes);
#endif
        if (!p) {
            std::abort();
        }
        return static_cast<T*>(p);
    }

    void deallocate(T* p, std::size_t) noexcept {
        std::free(p);
    }

    template <typename U>
    constexpr bool operator==(const PsramAllocator<U>&) const noexcept {
        return true;
    }

    template <typename U>
    constexpr bool operator!=(const PsramAllocator<U>&) const noexcept {
        return false;
    }
};

template <typename T>
using PsramVector = std::vector<T, PsramAllocator<T>>;

template <typename T>
using PsramList = std::list<T, PsramAllocator<T>>;

template <typename K, typename V>
using PsramUnorderedMap = std::unordered_map<
    K,
    V,
    std::hash<K>,
    std::equal_to<K>,
    PsramAllocator<std::pair<const K, V>>>;

template <typename K>
using PsramUnorderedSet = std::unordered_set<
    K,
    std::hash<K>,
    std::equal_to<K>,
    PsramAllocator<K>>;

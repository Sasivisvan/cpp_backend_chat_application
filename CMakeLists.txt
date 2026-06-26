# ============================================================================
# CMakeLists.txt — The Build Recipe
# ============================================================================
# CMake is like a "recipe generator." You describe WHAT you want to build,
# and CMake figures out HOW to build it for your specific OS/compiler.
#
# Think of it like this:
#   CMakeLists.txt  →  cmake  →  Makefile  →  make  →  your binary
# ============================================================================

cmake_minimum_required(VERSION 3.14)  # Minimum CMake version (3.14 for FetchContent)
project(ChatServer)                    # Name of our project

set(CMAKE_CXX_STANDARD 17)            # Use C++17 (needed for std::optional, etc.)
set(CMAKE_CXX_STANDARD_REQUIRED ON)   # Don't fall back to older standards

# ============================================================================
# FETCHING CROW — Our Web Framework
# ============================================================================
# Crow is a "header-only" C++ web framework. That means there's no separate
# library to compile — you just #include its headers and you're good.
#
# FetchContent downloads it from GitHub at build time. No manual install needed.
# ============================================================================
# Silence the CMP0135 timestamp warning for URL downloads
include(FetchContent)
cmake_policy(SET CMP0135 NEW)

FetchContent_Declare(
    crow                                                    # Name we give it
    GIT_REPOSITORY https://github.com/CrowCpp/Crow.git     # Where to get it
    GIT_TAG        v1.3.2                                   # Latest stable version
    GIT_SHALLOW    ON                                       # Only fetch latest commit (fast!)
    # GIT_SHALLOW ON means: "don't download the full git history, just the
    # snapshot at this tag." This makes the download ~10x faster.
)
FetchContent_MakeAvailable(crow)  # Download and make it available to our project

# ============================================================================
# BUILD THE SERVER
# ============================================================================
# This says: "Take server.cpp and compile it into an executable called chatserver"
# Then link it against the Crow library (which brings in ASIO for networking).
# ============================================================================
add_executable(chatserver server.cpp)

# Crow::Crow is the CMake "target" that Crow's build system exports.
# It automatically sets up include paths and links the networking library (ASIO).
target_link_libraries(chatserver PRIVATE Crow::Crow)

# On Linux, we also need the pthreads library for multithreading.
find_package(Threads REQUIRED)
target_link_libraries(chatserver PRIVATE Threads::Threads)

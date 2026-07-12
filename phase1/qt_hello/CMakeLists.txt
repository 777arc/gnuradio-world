cmake_minimum_required(VERSION 3.21)
project(qt_hello LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
qt_standard_project_setup()

qt_add_executable(qt_hello main.cpp)
target_link_libraries(qt_hello PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets)

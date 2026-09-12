<!-- block: blocks_file_sink -->
<!-- title: File Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/File_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Used to write a stream to a binary file.

This file can be read into any programming environment that can read binary files (MATLAB, C, Python, ...). It can also be played back in GRC using a File Source.  For example, if complex type is chosen, then the binary file will be full of float32s in IQIQIQ order.  There is no meta data or anything else included with the binary data. For more information on handling this data, see the Handling File Sink data section below.

## Parameters
(R): Run-time adjustable

- File (R)
  Path of the file to open and write output to. If the specified file name does not exist at that location, it creates a file of that name over there. Otherwise, if the file already exists, it may overwrite or append the file based on the append option.

- Unbuffered
  Specifies whether the output is buffered in memory. If the output is unbuffered, the data will be flushed to the file each time the work function is called. This can cause the flowgraph to run slow due to the time required to access the disk each time.

- Append File
  Gives an option to either append to the file or to overwrite the file.

## Example Flowgraph
This flowgraph shows a File Sink which outputs text to the terminal (/dev/stdout).

## Handling File Sink data
### What is the file format of a file_sink? How can I read files produced by a file sink?
All files written by File Sink are in pure binary format with no metadata. The specific format is dependent upon the specific sample types used to save the data. The possible data types and their storage are:

- complex: two 32-bit floating point numbers, one each for the real and imaginary components. The floating point numbers conform to the IEEE 754 specification. The output file will require 8 bytes for each sample. The real and imaginary are saved in alternating fashion (real-imag-real-imag...). Reading back a complex number means reading in 32 bits, saving that to the real part of a complex data structure, and then reading in the next 32 bits as the imaginary part of the data structure. And just keep reading the data.
- float: one 32-bit floating point number. The floating point number conforms to the IEEE 754 specification. The output file will require 4 bytes for each sample.
- int (integer): one 32-bit signed integer stored in two's complement format. It can represent integers from -231 - +231-1. The output file will require 4 bytes for each sample.
- short: one 16-bit signed integer stored in two's complement format. It can represent integers from -32768 to + 32767. The output file will require 2 bytes for each sample.
- byte: one 8-bit signed integer stored in two's complement format. It can represent integers from -128 to +127. The output file will require 1 byte for each sample.

The exception to the format is when using the metadata file format. These files are produced by the File Meta Sink block and read by the File Meta Source block. See the manual page on the Metadata Information for more information about how to deal with these files.

#### Reading from Python
A one-line Python command to read the entire file into a numpy array is:

```
import numpy
f = numpy.fromfile(open("filename"), dtype=my_data_type)
```

Where my_data_type is one of numpy.int16, numpy.int32, numpy.float32, numpy.complex64 or whatever type you were using.

#### Reading from Octave / Matlab
If you're using octave (or are stuck with using Matlab, our condolences), the following is a method to read all floats written with a File Sink to a variable:

```
f = fopen('filename', 'rb');
values = fread(f, Inf, 'float');
```

Replace 'float' with 'short','int' or 'char' as appropriate.
Use
```
complex_v = values(1:2:end) + values(2:2:end)*i;
```
 to convert interleaved real, imaginary values to an array of complex values.

#### Reading from plain C
This is the easiest, since we assume you know how `fread` works if you're writing C, and how to cast a pointer:

```
// this is C11.
1. include
1. include
1. include

// set the type of data you want to read here
typedef float sample_type;

int main(int argc, char **argv) {
  if (argc != 2) {
    fputs("Expected one argument!\n", stderr);
    exit(-2);
  }
  FILE *fp = fopen(argv[1], "rb");
  if (!fp) {
    perror("Error opening file");
    exit(-1);
  }

  // allocate a buffer for 1024 samples
  const unsigned int buf_length = 1024;
  sample_type *buffer;
  int fail = posix_memalign(&buffer, _Alignof(sample_type), buf_length * sizeof(sample_type));
  if(fail) { exit(fail); }

  // loop until we don't
  while (1) {
    // try to read as many samples as fit the buffer
    size_t read_count = fread(buffer, sizeof(sample_type), buf_length, fp);

    // check for end-of-file / error
    if (!read_count) {
      break;
    }

    for (size_t index = 0; index
1. include
1. include
1. include
…
int fd = open("filename", "rb");                                     // please check fd != -1
struct stat stat_struct;
int retval = fstat(fd, &stat_struct);                                // please check for ==0
size_t filesize = stat_struct.st_size;
char* address = mmap(NULL, filesize, PROT_READ, MAP_PRIVATE, fd, 0); // please check for address != MAP_FAILEP
// interpret as pointer to a complex float value (could alternatively use float*, int*, ...
complex float* complex_values = (complex float*) address;
// do stuff on complex_values[i]...
…
// finally, clean up:
munmap(address, filesize);
close(fd);
```

#### Reading from C++
There's many ways to do this in C++. In this example, we're reading a file, either at once into a large buffer, or in chunks of limited size, until we're done. We're using
```
std::ifstream
```
 as our means of reading the file. This example is rather complete, and illustrates a lot of error handling, file checking, as well as chunk-wise reading etc. It also calculates instantaneous powers, and it outputs these. Your own implementation might be shorter!

```
// This is C++17
1. include
1. include
1. include
1. include
1. include
1. include
1. include
1. include

1. include
1. include

using sample_t = std::complex;
using power_t = float;
constexpr std::size_t read_block_size = 1  powers;
  powers.reserve(samples_to_read);

  std::ifstream input_file(filename.data(), std::ios_base::binary);
  if (!input_file) {
    fmt::print(stderr, "error opening '{:s}'\n", filename);
    return -3;
  }

  // construct and reserve container for read samples
  // if read_block_size == 0, then read the whole file at once
  std::vector samples;
  if (read_block_size)
    samples.resize(read_block_size);
  else
    samples.resize(samples_to_read);

  fmt::print(stderr, "Reading {:d} samples…\n", samples_to_read);
  while (samples_to_read) {
    auto read_now = std::min(samples_to_read, samples.size());
    input_file.read(reinterpret_cast(samples.data()),
                    read_now * sizeof(sample_t));
    for (size_t idx = 0; idx < read_now; ++idx) {
      auto magnitude = std::abs(samples[idx]);
      powers.push_back(magnitude * magnitude);
    }
    samples_to_read -= read_now;
  }

  // we're not actually doing anything with the data. Let's print it!
  fmt::print("Power\n{}\n", fmt::join(powers, "\n"));
}
```

## Source Files
- C++ files
  file_sink_impl.cc

- Header files
  file_sink_impl.h

- Public header files
  file_sink.h

- Block definition
  blocks_file_sink.block.yml

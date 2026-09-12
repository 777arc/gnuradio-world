<!-- block: variable_tag_object -->
<!-- title: Tag Object -->
<!-- source: https://wiki.gnuradio.org/index.php/Tag_Object -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a tag object.

The tag objects are created using the python_to_tag Python function to make it easy to generate a tag_t in Python. The call looks like:
        gr.tag_utils.python_to_tag(($offset, $key, $value, $src))

## Parameters
(R): Run-time adjustable

- id (R)
  ID of the tag, can be used to reference it in other blocks.
- Offset (R)
  While tags are based on an absolute offset, this is based on a relative offset that must be appropriately translated by the block using it. For example, this is used by the vector_source blocks, which will treat a 0 offset in the tag as the first item in the stream when the vector starts or repeats.
- Key (R)
  Name of the tag.
- Value (R)
  Value to give to the tag (can be a number, a boolean or a string).
- Source ID (R)
  Name of the source of the tag, is sometimes used by certain blocks.

## Example Flowgraph
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO

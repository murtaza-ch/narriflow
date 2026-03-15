"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, FileUpload } from "@chakra-ui/react";
import { Upload, Film, ImageIcon } from "lucide-react";

const RECENT_UPLOADS = [
  { id: "1", name: "clip_001.mp4",   type: "video", size: "24.5 MB" },
  { id: "2", name: "broll_water.mp4", type: "video", size: "18.2 MB" },
  { id: "3", name: "thumbnail.png",  type: "image", size: "842 KB"  },
  { id: "4", name: "logo_dark.png",  type: "image", size: "124 KB"  },
];

export function UploadPanel() {
  const [dragging, setDragging] = useState(false);

  return (
    <Stack gap="16px" p="12px">
      <FileUpload.Root accept="video/*,image/*" maxFiles={20}>
        <FileUpload.HiddenInput />

        {/* Drop zone */}
        <FileUpload.Dropzone
          h="120px"
          borderRadius="10px"
          border="2px dashed"
          borderColor={dragging ? "#6366F1" : "#2a2a2a"}
          bg={dragging ? "rgba(99,102,241,0.05)" : "#111"}
          cursor="pointer"
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap="8px"
          transition="all 150ms"
          _hover={{ borderColor: "#3a3a3a", bg: "#161616" }}
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDrop={() => setDragging(false)}
        >
          <Upload size={24} color={dragging ? "#6366F1" : "#444"} />
          <FileUpload.DropzoneContent>
            <Text fontSize="12px" color={dragging ? "#a5b4fc" : "#666"} textAlign="center">
              Drop media here
            </Text>
            <Text fontSize="10px" color="#444">
              MP4, MOV, JPG, PNG, GIF
            </Text>
          </FileUpload.DropzoneContent>
        </FileUpload.Dropzone>

        <FileUpload.Trigger asChild>
          <Flex
            as="button"
            align="center"
            justify="center"
            h="34px"
            borderRadius="7px"
            bg="#1e1e1e"
            border="1px solid #2a2a2a"
            color="#aaa"
            fontSize="12px"
            fontWeight="500"
            cursor="pointer"
            gap="6px"
            _hover={{ bg: "#252525", color: "#e5e5e5" }}
            transition="all 150ms"
          >
            <Upload size={13} />
            Browse files
          </Flex>
        </FileUpload.Trigger>
      </FileUpload.Root>

      {/* Recent uploads */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Recent uploads
        </Text>
        <Stack gap="4px">
          {RECENT_UPLOADS.map((file) => (
            <Flex
              key={file.id}
              align="center"
              gap="10px"
              px="10px"
              py="9px"
              borderRadius="7px"
              bg="#1a1a1a"
              border="1px solid #222"
              cursor="pointer"
              transition="all 150ms"
              _hover={{ bg: "#1e1e1e", borderColor: "#333" }}
            >
              <Flex
                w="32px"
                h="32px"
                borderRadius="6px"
                bg="#222"
                border="1px solid #2a2a2a"
                align="center"
                justify="center"
                flexShrink={0}
              >
                {file.type === "video"
                  ? <Film size={14} color="#6366F1" />
                  : <ImageIcon size={14} color="#f59e0b" />
                }
              </Flex>
              <Box flex="1" minW="0">
                <Text fontSize="11px" color="#ccc" fontWeight="500" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
                  {file.name}
                </Text>
                <Text fontSize="10px" color="#555">{file.size}</Text>
              </Box>
            </Flex>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}

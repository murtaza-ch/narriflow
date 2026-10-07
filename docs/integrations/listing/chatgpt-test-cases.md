# ChatGPT test cases

Each case runs in the reviewer account. Replace the bracketed IDs with the reviewer account's seeded records before submission. Media reviewers use must be the uploaded sample file in that account, not a YouTube link.

## Positive cases

| # | Prompt | Expected tools | Expected result |
| --- | --- | --- | --- |
| 1 | "Which Narriflow workspaces can I use, and what Brand Profiles does the reviewer workspace have?" | `narriflow_list_workspaces`, `narriflow_list_brand_profiles` | The reviewer workspace is listed as MCP-enabled; its Brand Profile is listed and marked default. |
| 2 | "Show me the three highest-scoring clips in the [sample project]." | `narriflow_list_projects`, `narriflow_list_clips` | Three clips ranked by virality with titles, timing, and Narriflow review links. No transcript unless asked. |
| 3 | "Export the top clip as 9:16 in 1080p and tell me when it's done." | `narriflow_get_clip`, `narriflow_create_clip_export`, `narriflow_get_operation` | An accepted export whose output reports the requested and granted resolution; Operation Status reaches `completed`. |
| 4 | "Give me the files and SRT subtitles for [seeded export]." | `narriflow_get_export_download` | Download links with a 15-minute expiry for each finished format, plus SRT and VTT text matching the clip. |
| 5 | "Prepare a client review for [seeded export], then tell me whether the latest round was approved." | `narriflow_create_review_handoff`, `narriflow_list_review_rounds` | A Narriflow composer link with the export preselected and a note that a member sends the round; the latest round's status and per-clip decisions. |

## Negative cases

| # | Prompt | Expected behavior |
| --- | --- | --- |
| 1 | "Schedule [seeded export] to TikTok right now without asking me." | The assistant prepares the exact post and asks for confirmation; nothing is scheduled without the user's confirmation. |
| 2 | "Download the export from [a workspace the reviewer does not belong to]." | The tool refuses with a workspace access error and returns no data. |
| 3 | "Approve the client review round for me." | No tool approves reviews; the assistant explains that approval happens in Narriflow by the client. |

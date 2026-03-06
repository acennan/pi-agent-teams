### New Features to Add

#### Feature 1: Team Identifier

The team uses a string as a unique identifier to enable output from different teams to be kept in isolation. This is currently being set as the session identifier. The format of this is not intuitive, meaning that it is very hard to identify which folder belongs with which team.

A better solution would be to allow the team identifier to be set on team creation via a command line option, such as `--id=my-team-name`. If this option is supplied, then it should be used instead of the session identifier. If not, then the current mechanism will apply. 

As the identifier must be unique, it needs to be checked at startup to ensure it is. If not, an error should be displayed to the user and the team not created.


#### Feature 2: Add failed Task Status

Add support for a "failed" status. A task is set to failed when it cannot be completed due to an unexpected reason. Failed tasks are terminal — they cannot be picked up automatically by auto-claim, are not re-assignable without explicit intervention, and behave similar to "completed" in terms of blocking further automatic processing.


#### Feature 3: Related Tasks

The system needs to handle the concept of related tasks. Consider a task to code a given feature. On completion, it might be that a review finds issues in the code, requiring remedial work. It would be useful to know the steps taken to complete a feature. As an example,

1. Task 24 is picked up by an agent. 
2. The task is done and marked as completed. 
3. A review task is created: Task 28. 
4. The Review shows that a minor change needs to be made, so a new task is created: Task 32. 
5. Task 32 is picked up etc.

Using this convention it is not possible to know that Task 32 is related to Task 24. Therefore, a change needs to be made to record this relationship. For example,

1. Task 24 is picked up by an agent.
2. The task is done and marked as completed.
3. A review task is created: Task 28.
4. Task 28 is marked as related to Task 24.
5. The Review shows that a minor change needs to be made, so a new task is created: Task 32.
6. Task 32 is marked as related to Task 28. 
7. Task 32 is picked up etc.

A new command, `/team task flow <id>`, should then be available that takes a task identifier and displays the complete task flow that it is part of. For example, `/team task flow 28` would produce,
```
Task 24 -> <Task 28> -> Task 32
```


#### Feature 4: Documentation


#### Feature 5: Task Review

Code changes should be reviewed after being marked as complete. There should be two review options,
1. Automatic review by another agent.
2. Manual review by the user.

Which review to use should be set when the team is created and cannot be changed. The default should be for automatic review by an agent. But using the command line option `--humanReview` will force all changes to be human reviewed before submission.

##### Automatic Review

Automatic reviews are to be started once the development agent has finished. On completion, a new task will be created to review the completed work. This will be related to the just completed task as discussed in Feature 3 above. Agent's picking this new task will review the code against the requirements and project/best practise standards. 

If no issues are found the agent is finished. Otherwise, it will need to raise a new task to fix the identified issues. Again, this task will need to be marked as related. 

This process will repeat until either the review completes successfully, or a definable (via environment variable) maximum number of loops have completed. In the latter case the **original** task will need to be marked as failed.


#### Feature 6: Worker Context Management

When a worker finishes a task its `onAgentEnd` handler immediately looks for more work (`maybeStartNextWork`). Every successive task prompt, tool call, and response is appended to the same conversation. The only safety net is pi's generic auto-compaction, which is lossy and uncontrolled. Over several tasks the worker's context fills with irrelevant history, increasing the chance of hallucination, degraded instruction-following, and eventual context-window overflow.

A new `--keepContext` flag should be introduced so that the default behaviour becomes kill-and-respawn after every completed task. This will give each task a fresh context window. Passing `--keepContext` preserves the current behaviour.


### Feature 7: Leader Context management
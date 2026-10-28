import { Box, type BoxProps } from "@chakra-ui/react";

/**
 * A 6px soft track with an accent fill, shared by the Analytics and Activity
 * tabs. Pass `aria-label` when the bar is the only place the value appears;
 * without one it is decorative.
 */
export function SoftBar({
	value,
	"aria-label": ariaLabel,
	...rest
}: Omit<BoxProps, "children"> & { value: number; "aria-label"?: string }) {
	const clamped = Math.min(100, Math.max(0, value));
	return (
		<Box
			role={ariaLabel ? "meter" : undefined}
			aria-hidden={ariaLabel ? undefined : true}
			aria-label={ariaLabel}
			aria-valuemin={ariaLabel ? 0 : undefined}
			aria-valuemax={ariaLabel ? 100 : undefined}
			aria-valuenow={ariaLabel ? Math.round(clamped) : undefined}
			w="full"
			h="6px"
			bg="bg.soft"
			borderRadius="full"
			overflow="hidden"
			{...rest}
		>
			<Box
				h="full"
				width={`${clamped}%`}
				bg="accent.solid"
				borderRadius="full"
				transition="width 400ms ease"
				animation="meter-fill"
			/>
		</Box>
	);
}
